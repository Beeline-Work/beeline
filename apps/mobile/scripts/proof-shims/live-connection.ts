// Native proof stand-in: no server socket; reads come from the proof's workbench source.
export const sharedLiveConnection = () => ({ register: async () => () => undefined });
