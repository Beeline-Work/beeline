/** Browser Room reads retain the browser's normal fetch implementation. */
export const fetchOpeningRoom: typeof fetch = (...args) => globalThis.fetch(...args);
