import QRCode from 'qrcode';
window.renderMigajasMfaQr = (totp, account) => QRCode.toDataURL(window.MigajasMfaQr.authenticatorUri(totp, account), { width: 256, margin: 4, errorCorrectionLevel: 'M', type: 'image/png' });
import * as skinview3d from 'skinview3d';
window.skinview3d = skinview3d;
import {createClient} from '@supabase/supabase-js';
import {inspectPack} from './pack-inspector.js';
window.MigajasSupabase = {createClient};
window.inspectMigajasPack = inspectPack;
