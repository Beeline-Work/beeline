import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { MediaMetadata } from '@beeline/api-contract/media-metadata';
import { resetClientState } from '@/sync/client-reset';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { mediaMetadataCurrent, mediaMetadataFor, requestMediaLink, requestMediaPlayback, subscribeMediaCacheBoundary } from './media-cache-connection';
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
const id='11111111-1111-4111-8111-111111111111', origin='https://media.test';
const value=():MediaMetadata=>({objectId:id,size:3,mimeType:'image/png',sha256:'a'.repeat(64),expiresAt:Date.now()+60_000});
beforeEach(()=>{resetClientState();vi.mocked(monolithPhoneOperation).mockReset();});
afterEach(()=>{resetClientState();vi.restoreAllMocks();});
it('shares an in-flight ordinary read and reads again on later demand',async()=>{
  let finish!:(value:MediaMetadata)=>void;
  vi.mocked(monolithPhoneOperation).mockImplementation(()=>new Promise<any>(resolve=>{finish=resolve;}));
  const first=mediaMetadataFor(origin,'ada',id), second=mediaMetadataFor(origin,'ada',id), answer=value();
  expect(monolithPhoneOperation).toHaveBeenCalledExactlyOnceWith('readMediaMetadata',{objectId:id});
  finish(answer);expect(await first).toBe(answer);expect(await second).toBe(answer);expect(mediaMetadataCurrent(answer)).toBe(true);
  vi.mocked(monolithPhoneOperation).mockResolvedValue(value()); await mediaMetadataFor(origin,'ada',id);
  expect(monolithPhoneOperation).toHaveBeenCalledTimes(2);
});
it('an identity change rejects an in-flight old reply and clears current metadata',async()=>{
  const answer=value();vi.mocked(monolithPhoneOperation).mockResolvedValue(answer);await mediaMetadataFor(origin,'ada',id);
  let finish!:(value:MediaMetadata)=>void;vi.mocked(monolithPhoneOperation).mockImplementation(()=>new Promise<any>(resolve=>{finish=resolve;}));
  const pending=mediaMetadataFor(origin,'ada',id), boundary=vi.fn(), stop=subscribeMediaCacheBoundary(boundary);
  resetClientState();finish(value()); await expect(pending).rejects.toThrow('another session');
  expect(mediaMetadataCurrent(answer)).toBe(false);expect(boundary).toHaveBeenCalledWith({kind:'identity'});stop();
});
it('requests links and playback through ordinary socket operations',async()=>{
  const link={url:'https://media.test/signed',expiresIn:60};vi.mocked(monolithPhoneOperation).mockResolvedValue(link);
  expect(await requestMediaLink(id)).toBe(link);expect(await requestMediaPlayback(id)).toBe(link);
  expect(monolithPhoneOperation).toHaveBeenNthCalledWith(1,'readMediaLink',{objectId:id});
  expect(monolithPhoneOperation).toHaveBeenNthCalledWith(2,'readMediaPlayback',{objectId:id});
});
it('does not reuse expired file metadata',async()=>{
  const answer=value();vi.mocked(monolithPhoneOperation).mockResolvedValue(answer);await mediaMetadataFor(origin,'ada',id);
  vi.spyOn(Date,'now').mockReturnValue(answer.expiresAt);expect(mediaMetadataCurrent(answer)).toBe(false);
});
