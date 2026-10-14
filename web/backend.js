// SPDX-License-Identifier: GPL-3.0+
export class Backend {
  #worker;
  #requests = new Map();
  #next = 0;
  #closed = false;
  onFrame = null;
  onMetrics = null;
  constructor() {
    this.#worker = new Worker(new URL('./core-worker.js', import.meta.url));
    this.#worker.onmessage = ({ data }) => {
      if (data.type === 'frame') {
        this.onFrame?.(data);
        return;
      }
      if (data.type === 'metrics') {
        this.onMetrics?.(data);
        return;
      }
      const request = this.#requests.get(data.id);
      if (!request) return;
      this.#requests.delete(data.id);
      clearTimeout(request.timer);
      data.error ? request.reject(new Error(data.error)) : request.resolve(data.result);
    };
    this.#worker.onerror = error => this.dispose(new Error(error.message || 'Backend worker failed'));
  }
  request(action, data) {
    if (this.#closed) return Promise.reject(new Error('Backend worker is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => this.dispose(new Error('Backend worker timed out')), 30000);
      this.#requests.set(id, { resolve, reject, timer });
      this.#worker.postMessage({ id, action, data });
    });
  }
  send(action, data) {
    if (this.#closed) return;
    this.#worker.postMessage({ action, data });
  }
  dispose(error = new Error('Backend worker closed')) {
    this.#closed = true;
    this.#worker.terminate();
    for (const request of this.#requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.#requests.clear();
  }
}
