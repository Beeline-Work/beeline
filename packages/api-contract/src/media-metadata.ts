
export type MediaObjectMetadata = {
  readonly objectId:string;
  readonly sha256:string;
  readonly size:number;
  readonly mimeType:string;
  readonly expiresAt:number;
};
/** Metadata returned by the ordinary authenticated file read. */
export type MediaMetadata = MediaObjectMetadata & {
  readonly thumbnail?:MediaObjectMetadata;
};
export type MediaLink = {readonly url:string;readonly expiresIn:number};
