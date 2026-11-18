const MIN = 60_000;
const HOUR = 60 * MIN;
const SP_OFFSET_MS = -3 * HOUR;

export const estimateCents = (arrivalMs, departureMs, hourlyRateCents) =>
  Math.ceil((departureMs - arrivalMs) / HOUR) * hourlyRateCents;

export function finalAmount(reservation, exitMs, graceMin) {
  const over = exitMs - Date.parse(reservation.departure_expected);
  const extra = over > graceMin * MIN ? Math.ceil(over / HOUR) * reservation.hourly_rate_cents : 0;
  return { extra, final: reservation.price_estimate_cents + extra };
}

export function withinOpeningHours(hours, arrivalMs, departureMs) {
  if (!hours || hours === '24h') return true;
  const [open, close] = hours.split('-').map((h) => {
    const [hh, mm] = h.split(':').map(Number);
    return hh * 60 + mm;
  });
  const a = new Date(arrivalMs + SP_OFFSET_MS);
  const b = new Date(departureMs + SP_OFFSET_MS);
  const minutes = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10) && minutes(a) >= open && minutes(b) <= close;
}
