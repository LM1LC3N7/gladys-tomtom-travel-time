// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the TravelTimeApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { TravelTimeApp } from './src/app.js';
import { ACTIONS, SCENE_ACTIONS, STATE_FILE } from './src/constants.js';
import { fileStorage } from './src/store.js';
import { TomTomClient } from './src/tomtom.js';

const gladys = new GladysIntegration();
// The count of the day, the pauses and the last read of each trip are kept in
// /data, the one writable volume: a restart loop can neither drain the daily
// quota nor read a trip faster than its interval.
const client = new TomTomClient({ storage: fileStorage(STATE_FILE, { logger }) });
const app = new TravelTimeApp({ gladys, client });

// --- Discovery: the configured trips (no request to TomTom) ------------------
gladys.onScanRequest(() => app.publishDiscovered({ force: true }));

// --- A device was created: send its last values now, not at the next read ----
gladys.onDeviceCreated(() => app.publishStates());

// --- Configuration screen button ----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- Scene action: refresh a trip now (bounded by a minimal gap) ---------------
gladys.onSceneAction(SCENE_ACTIONS.REFRESH, (fields) => app.refreshTrip(fields));

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated: restarting');
  await app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
// A reconnection keeps the pauses, the refused key and the due times; it
// publishes the status and the Discovery list again (Gladys may have restarted).
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error(`Start failed: ${app.scrub(err)}`);
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.stop());

logger.info('Starting the TomTom travel time integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed: ${app.scrub(err)}`);
  process.exit(1);
});
