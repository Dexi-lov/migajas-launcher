import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const GIST_EVENTS_URL = "https://gist.githubusercontent.com/Dexi-lov/8f8babdea6a5bccfe2c2d8a4fe4d8849/raw/evento_migajas.json";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeUuid(value: unknown): string {
  return String(value ?? "").replaceAll("-", "").toLowerCase();
}

async function verifiedMinecraftProfile(token: string) {
  const result = await fetch("https://api.minecraftservices.com/minecraft/profile", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw new Error("Inicia sesión de nuevo con tu cuenta Microsoft para usar amigos.");
  const profile = await result.json();
  const uuid = normalizeUuid(profile.id);
  const username = String(profile.name ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(uuid) || !username) throw new Error("Minecraft devolvió un perfil inválido.");
  return { uuid, username, is_verified: true };
}

async function offlineSocialProfile(value: unknown) {
  const username = String(value ?? "").trim().normalize("NFC");
  if (!/^[\p{L}\p{N}_]{3,16}$/u.test(username)) {
    throw new Error("El username offline debe tener entre 3 y 16 caracteres alfanuméricos o guiones bajos.");
  }
  const normalized = username.toLowerCase();
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`migajas-launcher-offline:${normalized}`),
  ));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const uuid = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { uuid, username, is_verified: false };
}

async function eventWhitelist(instanceId: string) {
  const result = await fetch(`${GIST_EVENTS_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
  if (!result.ok) throw new Error("No se pudo consultar el catálogo de eventos.");
  const events = await result.json();
  if (!Array.isArray(events)) throw new Error("El catálogo de eventos no tiene un formato válido.");
  const event = events.find((item) => String(item?.id) === instanceId);
  if (!event) throw new Error("El evento ya no existe en el catálogo.");
  const whitelist = event.whitelist;
  if (!whitelist?.enabled || !Array.isArray(whitelist.allowed)) return [];
  return whitelist.allowed.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 2000);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Método no permitido." }, 405);
  try {
    const communityUrl = Deno.env.get("MIGAJAS_COMMUNITY_URL");
    if (communityUrl) {
      const upstream = await fetch(communityUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: request.body, signal: AbortSignal.timeout(15000),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    const payload = await request.json();
    const token = String(payload?.minecraftAccessToken ?? "");
    if (token.length > 8192) return response({ error: "La sesión de Minecraft no es válida." }, 401);
    const profile = token
      ? await verifiedMinecraftProfile(token)
      : payload?.accountType === "offline"
        ? await offlineSocialProfile(payload.identityUsername)
        : null;
    if (!profile) return response({ error: "Inicia sesión con Microsoft o con una cuenta offline válida para usar amigos." }, 401);
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const now = new Date().toISOString();
    await client.from("migajas_profiles").upsert({ ...profile, updated_at: now }, { onConflict: "uuid" }).throwOnError();

    switch (payload?.action) {
      case "offline": {
        await client.from("migajas_presence").delete().eq("uuid", profile.uuid).throwOnError();
        return response({ success: true });
      }
      case "heartbeat": {
        const mode = payload.mode === "playing" && typeof payload.instanceId === "string"
          ? "playing"
          : payload.mode === "afk" ? "afk" : "active";
        const instanceId = mode === "playing" ? payload.instanceId.slice(0, 64) : null;
        await client.from("migajas_presence").upsert({ uuid: profile.uuid, mode, instance_id: instanceId, updated_at: now }, { onConflict: "uuid" }).throwOnError();
        const { data: requests, error: requestsError } = await client.from("migajas_friendships")
          .select("requester_uuid,created_at")
          .eq("addressee_uuid", profile.uuid)
          .eq("status", "pending");
        if (requestsError) throw requestsError;
        const requesterIds = (requests ?? []).map((item) => item.requester_uuid);
        const { data: requestProfiles, error: profilesError } = requesterIds.length
          ? await client.from("migajas_profiles").select("uuid,username,is_verified").in("uuid", requesterIds)
          : { data: [], error: null };
        if (profilesError) throw profilesError;
        const requestProfilesById = new Map((requestProfiles ?? []).map((item) => [item.uuid, item]));
        return response({
          success: true,
          uuid: profile.uuid,
          username: profile.username,
          pendingRequests: (requests ?? []).map((item) => {
            const requester = requestProfilesById.get(item.requester_uuid);
            return { uuid: item.requester_uuid, username: requester?.username ?? "Jugador", isVerified: requester?.is_verified !== false, createdAt: item.created_at };
          }),
        });
      }
      case "friends": {
        const { data, error } = await client.from("migajas_friendships")
          .select("requester_uuid,addressee_uuid,status,created_at")
          .or(`requester_uuid.eq.${profile.uuid},addressee_uuid.eq.${profile.uuid}`);
        if (error) throw error;
        const ids = [...new Set((data ?? []).flatMap((row) => [row.requester_uuid, row.addressee_uuid]).filter((id) => id !== profile.uuid))];
        const [profiles, presence] = ids.length ? await Promise.all([
          client.from("migajas_profiles").select("uuid,username,is_verified").in("uuid", ids),
          client.from("migajas_presence").select("uuid,mode,instance_id,updated_at").in("uuid", ids),
        ]) : [{ data: [], error: null }, { data: [], error: null }];
        if (profiles.error) throw profiles.error;
        if (presence.error) throw presence.error;
        const profileMap = new Map((profiles.data ?? []).map((row) => [row.uuid, row]));
        const presenceMap = new Map((presence.data ?? []).map((row) => [row.uuid, row]));
        const friendships = (data ?? []).map((row) => {
          const uuid = row.requester_uuid === profile.uuid ? row.addressee_uuid : row.requester_uuid;
          const direction = row.status === "accepted" ? "friend" : row.requester_uuid === profile.uuid ? "sent" : "received";
          const online = presenceMap.get(uuid);
          const fresh = online && Date.now() - Date.parse(online.updated_at) < 45000;
          const friendProfile = profileMap.get(uuid) ?? { uuid, username: uuid, is_verified: false };
          return { uuid, username: friendProfile.username, isVerified: friendProfile.is_verified !== false, direction, online: Boolean(fresh), mode: fresh ? online.mode : "offline", instanceId: fresh && online.mode === "playing" ? online.instance_id : null };
        });
        return response({ friends: friendships });
      }
      case "friend_request": {
        if (payload.accept === true) {
          const target = normalizeUuid(payload.uuid);
          if (!/^[0-9a-f]{32}$/.test(target) || target === profile.uuid) return response({ error: "La solicitud no es válida." }, 400);
          const { data, error } = await client.from("migajas_friendships").update({ status: "accepted" })
            .eq("requester_uuid", target).eq("addressee_uuid", profile.uuid).eq("status", "pending")
            .select("id").maybeSingle();
          if (error) throw error;
          if (!data) return response({ error: "La solicitud ya no está disponible." }, 404);
          return response({ success: true, accepted: true });
        }
        const username = String(payload.username ?? "").trim();
        if (!/^[\p{L}\p{N}_]{3,16}$/u.test(username)) return response({ error: "Escribe un username de Minecraft válido." }, 400);
        const { data: targets, error: findError } = await client.from("migajas_profiles").select("uuid,username,is_verified").ilike("username", username).order("is_verified", { ascending: false }).order("updated_at", { ascending: false }).limit(1);
        if (findError) throw findError;
        const target = targets?.[0];
        if (!target) return response({ error: "Ese jugador todavía no ha iniciado sesión en Migajas Launcher." }, 404);
        if (target.uuid === profile.uuid) return response({ error: "No puedes enviarte una solicitud a ti mismo." }, 400);
        const { data: prior, error: priorError } = await client.from("migajas_friendships").select("id,status,requester_uuid,addressee_uuid").or(`and(requester_uuid.eq.${profile.uuid},addressee_uuid.eq.${target.uuid}),and(requester_uuid.eq.${target.uuid},addressee_uuid.eq.${profile.uuid})`).maybeSingle();
        if (priorError) throw priorError;
        if (prior?.status === "accepted") return response({ error: "Ya son amigos." }, 409);
        if (prior?.requester_uuid === target.uuid) {
          await client.from("migajas_friendships").update({ status: "accepted" }).eq("id", prior.id).throwOnError();
          return response({ success: true, accepted: true });
        }
        if (!prior) await client.from("migajas_friendships").insert({ requester_uuid: profile.uuid, addressee_uuid: target.uuid, status: "pending" }).throwOnError();
        return response({ success: true, accepted: false });
      }
      case "friend_remove": {
        const target = normalizeUuid(payload.uuid);
        await client.from("migajas_friendships").delete().or(`and(requester_uuid.eq.${profile.uuid},addressee_uuid.eq.${target}),and(requester_uuid.eq.${target},addressee_uuid.eq.${profile.uuid})`).throwOnError();
        return response({ success: true });
      }
      case "whitelist_presence": {
        const entries = await eventWhitelist(String(payload.instanceId ?? "").slice(0, 64));
        const { data: profiles, error: profilesError } = entries.length ? await client.from("migajas_profiles").select("uuid,username,is_verified").limit(1000) : { data: [], error: null };
        if (profilesError) throw profilesError;
        const allowed = new Set(entries.map((entry) => normalizeUuid(entry)));
        const allowedNames = new Set(entries.map((entry) => entry.toLocaleLowerCase()));
        const people = (profiles ?? []).filter((item) => allowed.has(item.uuid) || allowedNames.has(item.username.toLocaleLowerCase()));
        const { data: presence, error: presenceError } = people.length ? await client.from("migajas_presence").select("uuid,mode,instance_id,updated_at").in("uuid", people.map((item) => item.uuid)) : { data: [], error: null };
        if (presenceError) throw presenceError;
        const byId = new Map((presence ?? []).map((item) => [item.uuid, item]));
        const resolved = entries.map((entry) => people.find((person) => allowed.has(person.uuid) && normalizeUuid(entry) === person.uuid || allowedNames.has(entry.toLocaleLowerCase()) && person.username.toLocaleLowerCase() === entry.toLocaleLowerCase()) ?? { uuid: normalizeUuid(entry) || entry, username: entry });
        const uniquePeople = [...new Map(resolved.map((item) => [item.uuid, item])).values()];
        return response({ people: uniquePeople.map((person) => {
          const item = byId.get(person.uuid);
          const fresh = item && Date.now() - Date.parse(item.updated_at) < 45000;
          return { uuid: person.uuid, username: person.username, online: Boolean(fresh), mode: fresh ? item.mode : "offline", instanceId: fresh && item.mode === "playing" ? item.instance_id : null };
        }) });
      }
      default:
        return response({ error: "Acción desconocida." }, 400);
    }
  } catch (error) {
    console.error("migajas-social:", error);
    return response({ error: error instanceof Error ? error.message : "Error interno del servicio social." }, 400);
  }
});
