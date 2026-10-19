// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake and a BOM (a manifest once shipped broken).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, MIN_INTERVAL, SCENE_ACTIONS } from '../src/constants.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { deviceOf } from '../src/devices.js';

const readBuffer = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readBuffer(path).toString('utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('no mojibake and no BOM in the manifest, the docs and the sources', () => {
  const files = [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'index.js',
    ...readdirSync(new URL('../src/', import.meta.url))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `src/${name}`),
  ];
  assert.ok(files.length >= 16, 'every source file is checked');
  for (const file of files) {
    const buffer = readBuffer(file);
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = buffer.toString('utf8');
    assert.ok(!text.includes('\ufffd'), `${file} holds an invalid UTF-8 sequence`);
    for (const bad of ['\u00c3', '\u00c2', '\u00e2\u20ac']) {
      assert.ok(!text.includes(bad), `${file} holds mojibake (${bad})`);
    }
    assert.doesNotMatch(text, /[\u0300-\u036f]/, `${file} holds a bare combining mark`);
  }
  assert.match(read('docs/fr.md'), /é/);
  assert.match(manifest.config_schema[0].description.fr, /durée/);
});

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /my\.tomtom\.com\/keys/, `docs/${lang}.md explains the free key`);
    assert.match(docs, /My first API key/);
    assert.match(docs, /Pay As You Grow/, `docs/${lang}.md warns about the shared quota`);
    assert.match(docs, /Mapbox Traffic/, `docs/${lang}.md points to Mapbox Traffic`);
    assert.match(docs, /qleg/);
    assert.match(docs, /11024/);
  }
  assert.match(read('docs/en.md'), /never been tested with a real TomTom key/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec une vraie clé TomTom/i);
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  assert.match(manifest.config_schema[0].description.en, /not affiliated with TomTom/);
});

test('version 0.1.0 everywhere, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-tomtom-travel-time:${manifest.version}`,
  );
});

test('the license ships with the image, and names nobody', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.doesNotMatch(license, /Copyright \d{4}.*[A-Za-z]{3,}/, 'no name in LICENSE');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(read('Dockerfile'), /COPY .*LICENSE/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('sections are purely presentational, with https links', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} is too long`);
    }
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key]?.default, value, key);
  }
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, field.key);
    }
  }
  assert.equal(fields.api_key.type, 'secret');
  // Never "encrypted": Gladys keeps a secret in clear in its database.
  for (const file of ['docs/en.md', 'docs/fr.md', 'README.md']) {
    // "chiffre" (a digit) is fine; "chiffré", "chiffrer", "chiffrement" are not.
    assert.doesNotMatch(read(file), /encrypt|chiffr(?!es?\b)/i, file);
  }
  for (const [, text] of texts(manifest)) {
    assert.doesNotMatch(`${text.en} ${text.fr}`, /encrypt|chiffr(?!es?\b)/i);
  }
  assert.match(fields.api_key.description.en, /sent only to api\.tomtom\.com/);
  assert.match(fields.api_key.description.fr, /envoyée seulement à api\.tomtom\.com/);
  assert.equal(fields.poll_interval.default, 10);
  assert.equal(fields.poll_interval.min, MIN_INTERVAL);
  assert.deepEqual(
    fields.travel_mode.options.map((o) => o.value),
    ['car', 'truck'],
  );
  // The placeholder is a valid trip.
  assert.equal(normalizeConfig({ trips: fields.trips.placeholder.en }).trips.length, 1);
  assert.equal(normalizeConfig({ trips: fields.trips.placeholder.fr }).trips.length, 1);
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(manifest.actions[0].timeout_seconds <= 120);
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  assert.ok(index.includes('onSceneAction(SCENE_ACTIONS.REFRESH'));
  const [refresh] = manifest.scene_actions;
  assert.equal(refresh.fields[0].source, 'devices');
  assert.deepEqual(
    refresh.outputs.map((o) => o.key),
    [
      'refreshed',
      'travel_time_minutes',
      'traffic_delay_minutes',
      'distance_km',
      'no_traffic_time_minutes',
      'age_minutes',
    ],
  );
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
});

// DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
// for the categories this integration uses.
const CORE_UNITS = {
  duration: [
    'microseconds',
    'milliseconds',
    'seconds',
    'minutes',
    'hours',
    'days',
    'weeks',
    'months',
    'years',
  ],
  'distance-sensor': ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile'],
};

test('every feature uses a unit the core lists for its category', () => {
  const gladys = createFakeGladys({ selector: 'tomtom' });
  const device = deviceOf(gladys, { id: 'work', name: 'Work' });
  assert.equal(device.features.length, 4);
  for (const feature of device.features) {
    assert.ok(feature.category in CORE_UNITS, `${feature.category} is not checked`);
    assert.ok(CORE_UNITS[feature.category].includes(feature.unit), feature.external_id);
    assert.equal(feature.read_only, true);
  }
});
