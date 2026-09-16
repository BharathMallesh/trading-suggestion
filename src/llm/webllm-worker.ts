// Web worker that hosts the web-llm (WebGPU) engine, so model compilation and
// generation run off the main thread. Paired with createWebLLMChatModel().
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
