// Worker の入口。受け取ったメッセージを振り分けに渡して応答を送るだけにする(Worker の API を触るのはここだけ)。
import type { WorkerRequestMessage } from '../shared/protocol';
import { handleRequest } from './handle-request';

self.onmessage = (ev: MessageEvent<WorkerRequestMessage>) => {
  self.postMessage(handleRequest(ev.data));
};
