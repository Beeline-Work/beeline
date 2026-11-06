import { validateWebPushSubscription, webPushPublicKey } from '../web-push.js';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { token } from './values.js';


  export async function phoneRegisterPush(ctx: PhoneContext, input: Input<'registerPushDevice'>, viewerId: string) {
    if (input.platform === 'web') {
      if (!webPushPublicKey(process.env)) throw new Error('web push is not configured');
      await validateWebPushSubscription(input.token, input.keys);
    } else if (input.platform !== 'android' && input.platform !== 'ios') {
      throw new Error('invalid push platform');
    }
    await ctx.database.transaction(async (database) => {
      await database.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,web_keys,registered_at) VALUES($1,$2,$3,$4,$5::jsonb,now()) ON CONFLICT(token) DO UPDATE SET identity_id=EXCLUDED.identity_id,platform=EXCLUDED.platform,environment=EXCLUDED.environment,web_keys=EXCLUDED.web_keys,registered_at=CASE WHEN push_devices.identity_id IS DISTINCT FROM EXCLUDED.identity_id OR push_devices.web_keys IS DISTINCT FROM EXCLUDED.web_keys THEN now() ELSE push_devices.registered_at END,updated_at=now()`,
        [
          input.token,
          viewerId,
          input.platform,
          input.environment,
          input.platform === 'web' ? JSON.stringify(input.keys) : null,
        ],
      );
    });
    return { accepted: true };
  }

  export async function phoneReportUpdate(ctx: PhoneContext, input: Input<'reportRunningUpdate'>, viewerId: string, familyId?: string) {
    if (input.platform && !['ios', 'android', 'macos', 'windows', 'linux'].includes(input.platform))
      throw new Error('invalid platform');
    if (typeof input.deviceId !== 'string') throw new Error('invalid device');
    const deviceId = input.deviceId.trim();
    if (!deviceId || deviceId.length > 128) throw new Error('invalid device');
    await ctx.database.query(
      `INSERT INTO device_update_receipts(identity_id,device_id,receipt) VALUES($1,$2,$3::jsonb) ON CONFLICT(identity_id,device_id) DO UPDATE SET receipt=EXCLUDED.receipt,reported_at=now()`,
      [viewerId, deviceId, JSON.stringify({ ...input, deviceId })],
    );
    // Remember this installation on the sign-in family that reported it.
    // A browser session never reaches here, so it cannot inherit the receipt.
    if (familyId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(familyId)) {
      await ctx.database.query(
        `INSERT INTO phone_update_devices(family_id,identity_id,device_id)
         VALUES($1::uuid,$2,$3)
         ON CONFLICT(family_id) DO UPDATE
           SET identity_id=EXCLUDED.identity_id, device_id=EXCLUDED.device_id, reported_at=now()`,
        [familyId, viewerId, deviceId],
      );
    }
  }
