// WebGPU inference spike: load a small model on the GPU via web-llm, stream a
// reply, and report tokens/sec. Standalone (served at /webgpu.html) — proves
// the WebGPU path and measures the speedup before integrating it as an engine.
import { CreateMLCEngine } from '@mlc-ai/web-llm';

const MODEL = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

const $ = (id: string) => document.getElementById(id)!;
const status = (t: string) => ($('status').textContent = t);
const setBar = (p: number) => (($('fill') as HTMLElement).style.width = `${Math.round(p * 100)}%`);
const render = (t: string) => ($('out').textContent = t);

async function run(): Promise<void> {
  const btn = $('run') as HTMLButtonElement;
  btn.disabled = true;
  try {
    if (!navigator.gpu) {
      status('WebGPU is not available in this browser.');
      return;
    }
    status('Loading model — first run downloads ~400 MB, then it is cached for offline use…');
    const engine = await CreateMLCEngine(MODEL, {
      initProgressCallback: (p) => {
        setBar(p.progress ?? 0);
        status(p.text);
      },
    });

    setBar(1);
    status('Generating on the GPU…');
    const t0 = performance.now();
    const stream = await engine.chat.completions.create({
      messages: [{ role: 'user', content: 'In two short sentences, what makes a good friend?' }],
      stream: true,
      max_tokens: 160,
    });
    let out = '';
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta?.content;
      if (d) {
        out += d;
        render(out);
      }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const stats = await engine.runtimeStatsText();
    status(`Done in ${secs}s (wall clock).`);
    $('stats').textContent = `⚡ ${stats}`;
  } catch (e) {
    status('Error: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    btn.disabled = false;
  }
}

$('run').addEventListener('click', () => void run());
