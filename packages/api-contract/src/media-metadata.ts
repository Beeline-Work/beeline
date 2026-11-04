import type { RouterAuthorityCertificate } from './router-protocol.js';

export type MediaObjectMetadata = {
  readonly objectId:string;
  readonly sha256:string;
  readonly size:number;
  readonly mimeType:string;
  readonly expiresAt:number;
};
/** Immutable bytes still require current authority before a cold disk restore. */
export type MediaMetadata = MediaObjectMetadata & {
  readonly authority:RouterAuthorityCertificate;
  readonly thumbnail?:MediaObjectMetadata;
};
export type MediaLink = {readonly url:string;readonly expiresIn:number};
