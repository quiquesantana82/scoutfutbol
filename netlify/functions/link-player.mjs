// ─── BUSCAR JUGADOR EN API-FOOTBALL ───
// El admin la usa para vincular un jugador con su ID de la API.
// Uso: /.netlify/functions/link-player?q=apellido
// La clave de la API queda del lado del servidor, nunca viaja al navegador.

const API = 'https://v3.football.api-sports.io';

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) {
    return Response.json({ error: 'Escribí al menos 3 letras' }, { status: 400 });
  }

  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) return Response.json({ error: 'Falta API_FOOTBALL_KEY' }, { status: 500 });

  const r = await fetch(`${API}/players/profiles?search=${encodeURIComponent(q)}`, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!r.ok) return Response.json({ error: 'Error en API-Football' }, { status: 502 });

  const j = await r.json();
  const list = (j.response || []).slice(0, 10).map((item) => {
    const p = item.player || item;
    return {
      id: p.id,
      nombre: p.name,
      edad: p.age || '',
      nacionalidad: p.nationality || '',
      nacimiento: (p.birth && p.birth.date) || '',
      foto: p.photo || '',
    };
  });

  return Response.json({ resultados: list });
};
