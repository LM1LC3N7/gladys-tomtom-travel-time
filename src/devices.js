// -----------------------------------------------------------------------------
// The Gladys device of a trip and its states. Pure.
//
// The device always carries its four features, whatever the last answer
// held: a device published again never loses a feature (the core would mark
// it `structure_changed`, and "Update" would drop the history).
//
// Categories and units are the ones the core lists for them
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js):
// `duration` in `minutes`, `distance-sensor` in `km`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES } from './constants.js';

const round1 = (value) => Math.round(value * 10) / 10;
const minutes = (s) => (s === null || s === undefined ? null : round1(s / 60));
const km = (m) => (m === null || m === undefined ? null : round1(m / 1000));

const DURATION = {
  category: CAT.DURATION,
  type: TYPES.DURATION.DECIMAL,
  unit: UNITS.MINUTES,
  min: 0,
  max: 10000,
};

/** [key, name, kind, value of a reading]: the order of the features. */
export const FEATURE_LIST = [
  [FEATURES.TRAVEL_TIME, 'Travel time with traffic', DURATION, (r) => minutes(r.travelTime)],
  [FEATURES.TRAFFIC_DELAY, 'Traffic delay', DURATION, (r) => minutes(r.trafficDelay)],
  [
    FEATURES.DISTANCE,
    'Distance',
    {
      category: CAT.DISTANCE_SENSOR,
      type: TYPES.SENSOR.DECIMAL,
      unit: UNITS.KM,
      min: 0,
      max: 40000,
    },
    (r) => km(r.length),
  ],
  [
    FEATURES.NO_TRAFFIC_TIME,
    'Travel time without traffic',
    DURATION,
    (r) => minutes(r.noTrafficTime),
  ],
];

export const idsOf = (gladys, trip) => gladys.externalIds(DEVICE_TYPE, trip.id);

/** The Gladys device of a trip (one per trip). */
export function deviceOf(gladys, trip) {
  const ids = idsOf(gladys, trip);
  return {
    name: trip.name,
    external_id: ids.device,
    // The integration reads TomTom at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features: FEATURE_LIST.map(([key, name, kind]) => ({
      name,
      external_id: ids.feature(key),
      category: kind.category,
      type: kind.type,
      unit: kind.unit,
      min: kind.min,
      max: kind.max,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
  };
}

/** The values of a reading, in the units of the features (minutes, km). */
export function valuesOf(reading) {
  return Object.fromEntries(FEATURE_LIST.map(([key, , , value]) => [key, value(reading)]));
}

/** The states of a reading, for the publishStates format (a missing value is left out). */
export function statesOf(gladys, trip, reading) {
  const ids = idsOf(gladys, trip);
  const values = valuesOf(reading);
  return FEATURE_LIST.filter(([key]) => values[key] !== null).map(([key, , kind]) => ({
    device_feature_external_id: ids.feature(key),
    state: Math.min(kind.max, values[key]),
  }));
}
