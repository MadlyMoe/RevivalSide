'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bundleRelFromOutputRel,
  collectWikiAssetRequests,
  readWikiDataFiles,
} = require('./ensure-wiki-assets');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revivalside-wiki-'));
try {
  const dataRoot = path.join(root, 'wiki-data');
  const gameRoot = path.join(root, 'game');
  const dataDir = path.join(gameRoot, 'Data');
  const bundle = path.join(dataDir, 'StreamingAssets', 'test.asset');
  const assetUrl = '/asset-png/Data/StreamingAssets/test/Texture2D/icon.png';
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, 'fixture');
  fs.writeFileSync(path.join(dataRoot, 'units.json'), JSON.stringify([{ image: assetUrl }]));
  fs.writeFileSync(path.join(dataRoot, 'assets.json'), JSON.stringify({ sections: { units: 'units.json' } }));

  assert.strictEqual(readWikiDataFiles(path.join(dataRoot, 'assets.json')).length, 2);
  assert.strictEqual(bundleRelFromOutputRel('Data/StreamingAssets/test/Texture2D/icon.png'), 'Data/StreamingAssets/test');
  const requests = collectWikiAssetRequests(path.join(dataRoot, 'assets.json'), { gameRoot, dataDir });
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].source, bundle);
  console.log('[wiki] PASS split data manifest and on-demand bundle lookup');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
