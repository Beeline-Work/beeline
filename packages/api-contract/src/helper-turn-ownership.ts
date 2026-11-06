/** Existing machine registration owns these controls. No public admission pass
 * is sent. Owned-row interpretation is a server protocol rollback floor even
 * with admission disabled; it is independent of native runtime 40. */
export type HelperTurnOwnershipSource = {
  readonly connectionId: string;
  readonly epoch: number;
};
