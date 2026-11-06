import { createContext } from 'react';
import { liveDraftDrainStore } from './live-draft-drain';

/** The Room visit supplies presentation state to rows independently of durable DTOs. */
export const RoomPresentationContext = createContext(liveDraftDrainStore);
