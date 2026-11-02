// Deliberately no transport executor or admission factory in the feature API.
// Owners integrate the private admission core only at a negotiated migration gate.
export { routes } from './routes.js';
export type { RouteId, RouteInput, RouteOutput } from './routes.js';
export type { Pass } from './private/admission.js';
