import { MonolithRigTransport } from './monolith-rig-transport';

/**
 * The phone has one write transport: the authenticated monolith phone API.
 * Keep the established public name while callers migrate independently.
 */
export class BuzzRigTransport extends MonolithRigTransport {}
