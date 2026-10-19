// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

import { DAILY_LIMIT } from './constants.js';

const plural = (n, one, many) => (n === 1 ? one : many);

/** 2500 -> "2,500" / "2 500". */
export const count = (n, lang) =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'fr' ? '\u202f' : ',');

/** "2026-10-18T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why a trip has no fresh value. */
export const REASONS = {
  refused: { en: 'API key refused', fr: "clé d'API refusée" },
  quota: { en: 'daily quota of the key reached', fr: 'quota du jour de la clé atteint' },
  limited: { en: 'too many requests (429)', fr: 'trop de requêtes (429)' },
  blocked: { en: 'refused by TomTom (403)', fr: 'refusé par TomTom (403)' },
  budget: { en: 'daily quota spent', fr: 'quota du jour épuisé' },
  no_route: { en: 'no route between the points', fr: 'aucun itinéraire entre les points' },
  bad_request: { en: 'request refused by TomTom', fr: 'requête refusée par TomTom' },
  failed: { en: 'no answer', fr: 'pas de réponse' },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

const both = (en, fr) => ({ en, fr });

/** "every 10 min, 06:00 to 20:00 (Europe/Paris)" / "toutes les 10 min, de 6 h à 20 h". */
export function schedule(config, lang) {
  const { intervalMinutes: i, activeFrom: from, activeUntil: until, timezone } = config;
  const whole = (until - from + 24) % 24 === 0;
  if (lang === 'fr') {
    return `toutes les ${i} min${whole ? '' : `, de ${from} h à ${until} h (${timezone})`}`;
  }
  return `every ${i} min${whole ? '' : `, ${from}:00 to ${until}:00 (${timezone})`}`;
}

export const T = {
  notConfigured: both(
    'Enter your TomTom API key and at least one trip.',
    "Saisissez votre clé d'API TomTom et au moins un trajet.",
  ),
  noKey: both('Enter your TomTom API key.', "Saisissez votre clé d'API TomTom."),
  noTrip: both(
    'No trip to read: enter one as "Name | lat,lon | lat,lon".',
    'Aucun trajet à lire : saisissez-en un sous la forme « Nom | lat,lon | lat,lon ».',
  ),
  overQuota: (planned) =>
    both(
      `Configuration refused: it plans ${count(planned, 'en')} requests a day (trips × reads a day), more than the ${count(DAILY_LIMIT, 'en')} of the free plan. Raise the interval, shorten the reading window or remove trips. Nothing is read meanwhile.`,
      `Configuration refusée : elle prévoit ${count(planned, 'fr')} requêtes par jour (trajets × relevés par jour), plus que les ${count(DAILY_LIMIT, 'fr')} de l'offre gratuite. Augmentez l'intervalle, réduisez la plage horaire ou retirez des trajets. Rien n'est lu en attendant.`,
    ),
  keyRefused: both(
    'TomTom refused the API key (wrong, inactive or without access to the Routing API): the reads stop. Check the key on my.tomtom.com/keys; one new try every 6 hours until the key changes.',
    "TomTom a refusé la clé d'API (erronée, inactive ou sans accès à la Routing API) : les relevés s'arrêtent. Vérifiez la clé sur my.tomtom.com/keys ; un nouvel essai toutes les 6 heures jusqu'à ce que la clé change.",
  ),
  quotaReached: (until) =>
    both(
      `TomTom says the daily quota of the key is reached: no request before ${utcTime(until)}.`,
      `TomTom indique que le quota du jour de la clé est atteint : aucune requête avant ${utcTime(until)}.`,
    ),
  blocked: (until) =>
    both(
      `TomTom refused the requests without saying why (403): no request before ${utcTime(until)}, then a pause that doubles if it goes on.`,
      `TomTom a refusé les requêtes sans dire pourquoi (403) : aucune requête avant ${utcTime(until)}, puis une pause qui double si cela continue.`,
    ),
  rateLimited: (until) =>
    both(
      `TomTom asks to slow down (too many requests): no request before ${utcTime(until)}.`,
      `TomTom demande de ralentir (trop de requêtes) : aucune requête avant ${utcTime(until)}.`,
    ),
  budgetSpent: (until) =>
    both(
      `The ${count(DAILY_LIMIT, 'en')} requests of the day are spent: the reads resume at ${utcTime(until)}.`,
      `Les ${count(DAILY_LIMIT, 'fr')} requêtes du jour sont épuisées : les relevés reprennent à ${utcTime(until)}.`,
    ),
  invalidTrips: (names, dropped, max) => {
    const en = [];
    const fr = [];
    if (names.length > 0) {
      const list = names.slice(0, 5).join(', ');
      en.push(
        `${names.length} ${plural(names.length, 'trip', 'trips')} ignored (expected "Name | lat,lon | lat,lon", unique names with a Latin letter or a digit): ${list}`,
      );
      fr.push(
        `${names.length} ${plural(names.length, 'trajet ignoré', 'trajets ignorés')} (format attendu « Nom | lat,lon | lat,lon », noms uniques avec une lettre latine ou un chiffre) : ${list}`,
      );
    }
    if (dropped > 0) {
      en.push(`${dropped} more ${plural(dropped, 'trip', 'trips')} ignored: ${max} at most`);
      fr.push(
        `${dropped} ${plural(dropped, 'trajet', 'trajets')} de plus ${plural(dropped, 'ignoré', 'ignorés')} : ${max} au maximum`,
      );
    }
    return both(en.join('. '), fr.join('. '));
  },
  notWritable: both(
    'The /data folder cannot be written: the count of the day and the pauses are kept in memory only, and the first reads wait one whole interval after each start',
    "Le dossier /data n'est pas inscriptible : le compte du jour et les pauses ne sont gardés qu'en mémoire, et les premiers relevés attendent un intervalle entier après chaque démarrage",
  ),
  invalidTimezone: (zone) =>
    both(
      `Unknown time zone: ${zone} used instead`,
      `Fuseau horaire inconnu : ${zone} utilisé à la place`,
    ),
  /** The connected status: the trips, the plan, and what fails. */
  ok: ({ config, failing = [] }) => {
    const n = config.trips.length;
    let en = `${n} ${plural(n, 'trip', 'trips')}, ${schedule(config, 'en')}: ${count(config.planned, 'en')} requests a day planned, out of ${count(DAILY_LIMIT, 'en')}.`;
    let fr = `${n} ${plural(n, 'trajet', 'trajets')}, ${schedule(config, 'fr')} : ${count(config.planned, 'fr')} requêtes par jour prévues, sur ${count(DAILY_LIMIT, 'fr')}.`;
    if (failing.length > 0) {
      en += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      fr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return both(en, fr);
  },
};
