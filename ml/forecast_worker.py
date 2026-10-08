#!/usr/bin/env python3
"""Local forecast worker for Kronos and Chronos-Bolt (research only).

Started by paper-bot/foundation.mjs as a child process. Talks JSON lines:
one request per stdin line, one reply per stdout line. Models load lazily on
first use and stay in memory. Nothing leaves this machine except the one-time
model download from Hugging Face.

Request:  {"id": 1, "model": "kronos" | "chronos", "series": [[{date, open, high,
           low, close, volume}, ...], ...], "steps": 5, "samples": 20}
Reply:    {"id": 1, "ok": true, "results": [...]} — per series:
  kronos  → {"paths": [[close at step 1..steps] x samples]}  (sampled futures)
  chronos → {"levels": [0.1 … 0.9], "quantiles": [[q per level] x steps]}
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "kronos-src"))

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

_models = {}


def device():
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def load(name):
    if name in _models:
        return _models[name]
    import torch

    torch.manual_seed(0)
    if name == "kronos":
        from model import Kronos, KronosTokenizer

        tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
        mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small")
        tok.eval()
        mdl.eval()
        _models[name] = (tok.to(device()), mdl.to(device()))
    elif name == "chronos":
        from chronos import BaseChronosPipeline

        _models[name] = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-bolt-small", device_map="cpu", torch_dtype=torch.float32
        )
    else:
        raise ValueError("unknown model " + str(name))
    return _models[name]


def kronos_forecast(series, steps, samples):
    """Sampled future paths. Each series is normalised on its own window (as the
    official predictor does); every batch row is one independent sample."""
    import numpy as np
    import pandas as pd
    import torch
    from model.kronos import auto_regressive_inference, calc_time_stamps

    tok, mdl = load("kronos")
    xs, xst, yst, stats = [], [], [], []
    for rows in series:
        df = pd.DataFrame(rows)
        df["amount"] = df["volume"] * df[["open", "high", "low", "close"]].mean(axis=1)
        x = df[["open", "high", "low", "close", "volume", "amount"]].values.astype(np.float32)
        ts = pd.to_datetime(df["date"])
        future = pd.Series(pd.bdate_range(ts.iloc[-1] + pd.Timedelta(days=1), periods=steps))
        m, s = x.mean(axis=0), x.std(axis=0)
        xs.append(np.clip((x - m) / (s + 1e-5), -5, 5))
        xst.append(calc_time_stamps(ts).values.astype(np.float32))
        yst.append(calc_time_stamps(future).values.astype(np.float32))
        stats.append((m, s))
    lengths = {len(x) for x in xs}
    if len(lengths) != 1:
        raise ValueError("all series in one kronos request must have the same length")
    # Replicate each series `samples` times: rows of the batch = independent draws.
    rep = lambda a: torch.from_numpy(np.repeat(np.stack(a), samples, axis=0)).to(device())
    with torch.no_grad():
        preds = auto_regressive_inference(
            tok, mdl, rep(xs), rep(xst), rep(yst), max_context=512, pred_len=steps,
            clip=5, T=1.0, top_k=0, top_p=0.9, sample_count=1, verbose=False,
        )
    preds = preds[:, -steps:, :]  # (series*samples, steps, 6)
    out = []
    for k, (m, s) in enumerate(stats):
        block = preds[k * samples:(k + 1) * samples, :, 3] * (s[3] + 1e-5) + m[3]
        out.append({"paths": block.round(4).tolist()})
    return out


def chronos_forecast(series, steps):
    import torch

    pipe = load("chronos")
    levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    ctx = [torch.tensor([r["close"] for r in rows], dtype=torch.float32) for rows in series]
    q, _ = pipe.predict_quantiles(ctx, prediction_length=steps, quantile_levels=levels)
    return [{"levels": levels, "quantiles": q[i].numpy().round(4).tolist()} for i in range(len(series))]


def handle(req):
    steps = int(req.get("steps", 5))
    series = req["series"]
    if req["model"] == "kronos":
        return kronos_forecast(series, steps, int(req.get("samples", 20)))
    if req["model"] == "chronos":
        return chronos_forecast(series, steps)
    if req["model"] == "ping":
        return []
    raise ValueError("unknown model " + str(req["model"]))


def main():
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            t0 = time.time()
            results = handle(req)
            reply = {"id": req.get("id"), "ok": True, "results": results, "seconds": round(time.time() - t0, 2)}
        except Exception as e:  # report, keep serving
            reply = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
