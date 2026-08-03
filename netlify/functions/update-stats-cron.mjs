// ─── ACTUALIZACIÓN PROGRAMADA ───
// Corre sola los LUNES y VIERNES a las 09:00 UTC (06:00 Uruguay).
// Solo llama a refresh-stats, que hace el trabajo real.

export default async () => {
  const url = `${process.env.URL}/.netlify/functions/refresh-stats?secret=${process.env.REFRESH_SECRET}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  console.log('Actualización programada:', JSON.stringify(j));
  return new Response('ok');
};

export const config = {
  schedule: '0 9 * * 1,5',
};
