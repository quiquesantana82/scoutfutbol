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
    `${SUPABASE_URL}/rest/v1/players?select=id,nombre,api_football_id,api_season,fotmob_id,stats_source&or=(api_football_id.not.is.null,fotmob_id.not.is.null)`,
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
      // ── FUENTE FOTMOB ──
      if (p.stats_source === 'fotmob') {
        if (!p.fotmob_id) {
          results.push({ jugador: p.nombre, ok: false, motivo: 'Fuente FotMob sin ID FotMob' });
          continue;
        }
        const temporadasFM = await fetchFotmob(p.fotmob_id);
        if (!temporadasFM || !temporadasFM.length) {
          results.push({ jugador: p.nombre, ok: false, motivo: 'Sin datos en FotMob' });
          continue;
        }
        const updFM = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ stats: temporadasFM, stats_updated_at: new Date().toISOString() }),
        });
        results.push({ jugador: p.nombre, ok: updFM.ok, fuente: 'FotMob', temporadas: temporadasFM.map(s => s.temporada_label).join(', '), partidos_ultima: temporadasFM[0].partidos });
        continue;
      }

      // ── FUENTE API-FOOTBALL (por defecto) ──
      if (!p.api_football_id) {
        results.push({ jugador: p.nombre, ok: false, motivo: 'Sin ID API-Football' });
        continue;
      }
      const forzada = (p.api_season || '').match(/^(\d{4})/);
      let base, euro, primera = null;

      if (forzada) {
        // El admin eligió la temporada más reciente (ej: "2025/2026" => season=2025, estilo europeo)
        base = parseInt(forzada[1]);
        euro = p.api_season.includes('/');
      } else {
        // Automática: detecta si la temporada actual tiene datos; si no, arranca en la anterior
        euro = false;
        primera = await fetchSeasonStats(API_KEY, p.api_football_id, year);
        base = (primera && primera.partidos) ? year : year - 1;
        if (base !== year) primera = null;
      }

      // Trae la temporada base y las dos anteriores
      const temporadas = [];
      for (const y of [base, base - 1, base - 2, base - 3]) {
        let s = (y === year && primera) ? primera : await fetchSeasonStats(API_KEY, p.api_football_id, y);
        if (s && s.partidos) {
          s.temporada_label = euro ? `${y}/${y + 1}` : String(y);
          temporadas.push(s);
        }
      }

      if (!temporadas.length) {
        results.push({ jugador: p.nombre, ok: false, motivo: 'Sin datos en la API' });
        continue;
      }

      const upd = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${p.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          stats: temporadas,
          stats_updated_at: new Date().toISOString(),
        }),
      });

      results.push({
        jugador: p.nombre,
        ok: upd.ok,
        temporadas: temporadas.map(s => s.temporada_label).join(', '),
        partidos_ultima: temporadas[0].partidos,
      });
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

// ─── FOTMOB (fuente alternativa, servicio no oficial) ───
// Trae las stats de la liga principal de la temporada en curso.
// El formato de FotMob puede cambiar sin aviso: el parseo es defensivo.
async function fetchFotmob(fotmobId) {
  const r = await fetch(`https://www.fotmob.com/api/playerData?id=${fotmobId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) return null;
  let j;
  try { j = await r.json(); } catch { return null; }

  const ml = j.mainLeague;
  if (!ml || !ml.stats || !ml.stats.length) return null;

  // Mapa título -> valor (los títulos vienen en inglés)
  const map = {};
  for (const s of ml.stats) {
    const t = (s.title || '').toLowerCase().trim();
    let v = s.value;
    if (v && typeof v === 'object') v = (v.numberValue !== undefined ? v.numberValue : v.fallback);
    if (t) map[t] = v;
  }
  const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(',', '.').replace('%', ''));
    return isNaN(n) ? null : n;
  };
  const pick = (...keys) => {
    for (const k of keys) if (map[k] !== undefined) return map[k];
    return null;
  };

  const partidos = num(pick('matches', 'appearances', 'matches played')) || 0;
  if (!partidos) return null;

  const rating = num(pick('fotmob rating', 'rating'));
  const acc = pick('shot accuracy', 'shots on target %');
  const equipo = (j.primaryTeam && j.primaryTeam.teamName) || '';

  const t = {
    temporada: ml.season || '',
    temporada_label: ml.season || 'Actual',
    fuente: 'FotMob',
    partidos: partidos,
    minutos: num(pick('minutes played', 'minutes')),
    goles: num(pick('goals')),
    asistencias: num(pick('assists')),
    pases_clave: num(pick('chances created', 'key passes')),
    rating: rating !== null ? rating.toFixed(2) : null,
    precision_tiros: acc !== null && acc !== undefined ? String(acc).includes('%') ? String(acc) : acc + '%' : null,
    amarillas: num(pick('yellow cards')),
    rojas: num(pick('red cards')),
    penales_convertidos: num(pick('penalties scored', 'penalty goals')),
    atajadas: num(pick('saves')),
    goles_recibidos: num(pick('goals conceded')),
    vallas: num(pick('clean sheets')),
    equipos: equipo,
    ligas: ml.leagueName || '',
  };
  return [t];
}
