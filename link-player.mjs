// ─── REFRESH STATS ───
// Recorre todos los jugadores con api_football_id, consulta API-Football
// y guarda las estadísticas en la columna `stats` (JSONB) de Supabase.
// Se puede llamar a mano desde el admin: /.netlify/functions/refresh-stats?secret=XXX
// La función programada (update-stats-cron) la llama sola lunes y viernes.

const API = 'https://v3.football.api-sports.io';

export default async (req) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.REFRESH_SECRET || secret !== process.env.REFRESH_SECRET) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY || !API_KEY) {
    return Response.json({ error: 'Faltan variables de entorno' }, { status: 500 });
  }

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // Trae TODOS los jugadores vinculados, de todas las empresas
  const listRes = await fetch(
    `${SUPABASE_URL}/rest/v1/players?select=id,nombre,api_football_id&api_football_id=not.is.null`,
    { headers: sbHeaders }
  );
  if (!listRes.ok) {
    return Response.json({ error: 'Error leyendo Supabase', detail: await listRes.text() }, { status: 500 });
  }
  const players = await listRes.json();

  const year = new Date().getFullYear();
  const results = [];

  for (const p of players) {
    try {
      // Prueba temporada actual; si no hay datos, prueba la anterior
      let stats = await fetchSeasonStats(API_KEY, p.api_football_id, year);
      if (!stats || !stats.partidos) {
        const prev = await fetchSeasonStats(API_KEY, p.api_football_id, year - 1);
        if (prev && prev.partidos) stats = prev;
      }

      if (!stats) {
        results.push({ jugador: p.nombre, ok: false, motivo: 'Sin datos en la API' });
        continue;
      }

      const upd = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${p.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          stats: stats,
          stats_updated_at: new Date().toISOString(),
        }),
      });

      results.push({ jugador: p.nombre, ok: upd.ok, temporada: stats.temporada, partidos: stats.partidos, goles: stats.goles });
    } catch (e) {
      results.push({ jugador: p.nombre, ok: false, motivo: String(e) });
    }
  }

  return Response.json({
    actualizados: results.filter(r => r.ok).length,
    total: players.length,
    detalle: results,
  });
};

async function fetchSeasonStats(apiKey, playerId, season) {
  const r = await fetch(`${API}/players?id=${playerId}&season=${season}`, {
    headers: { 'x-apisports-key': apiKey },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const resp = j.response && j.response[0];
  if (!resp || !resp.statistics || !resp.statistics.length) return null;

  // Un jugador puede tener varias entradas (liga + copa + selección): se suman todas
  let partidos = 0, minutos = 0, goles = 0, asistencias = 0, pasesClave = 0;
  let amarillas = 0, rojas = 0, atajadas = 0, golesRecibidos = 0, penales = 0;
  let ratingSum = 0, ratingApps = 0;
  const equipos = new Set(), ligas = new Set();

  for (const s of resp.statistics) {
    const apps = (s.games && s.games.appearences) || 0;
    partidos += apps;
    minutos += (s.games && s.games.minutes) || 0;
    goles += (s.goals && s.goals.total) || 0;
    asistencias += (s.goals && s.goals.assists) || 0;
    atajadas += (s.goals && s.goals.saves) || 0;
    golesRecibidos += (s.goals && s.goals.conceded) || 0;
    pasesClave += (s.passes && s.passes.key) || 0;
    amarillas += (s.cards && s.cards.yellow) || 0;
    rojas += (s.cards && s.cards.red) || 0;
    penales += (s.penalty && s.penalty.scored) || 0;
    if (s.games && s.games.rating && apps > 0) {
      ratingSum += parseFloat(s.games.rating) * apps;
      ratingApps += apps;
    }
    if (s.team && s.team.name) equipos.add(s.team.name);
    if (s.league && s.league.name) ligas.add(s.league.name);
  }

  return {
    temporada: season,
    partidos,
    minutos,
    goles,
    asistencias,
    pases_clave: pasesClave,
    rating: ratingApps > 0 ? (ratingSum / ratingApps).toFixed(2) : null,
    amarillas,
    rojas,
    penales_convertidos: penales,
    atajadas: atajadas || null,
    goles_recibidos: golesRecibidos || null,
    equipos: [...equipos].join(', '),
    ligas: [...ligas].join(', '),
  };
}
