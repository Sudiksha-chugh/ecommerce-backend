const path = require('path');
const fs = require('fs');
const {createHash} = require('crypto');
const root = path.resolve(__dirname, '../../..');
// Exact filenames are intentional: Catalog has two historical migrations numbered 001.
const manifests = Object.freeze({
  orders: ['000_initial_schema.sql', '001_order_saga.sql', '002_saga_compensation.sql'],
  inventory: ['000_initial_schema.sql', '001_command_dedup.sql'],
  payments: ['000_initial_schema.sql', '001_inbox.sql', '002_operation_update_permissions.sql'],
  catalog: ['000_initial_schema.sql', '001_add_product_constraints.sql',
    '001_inventory_reservations.sql', '002_inventory_reservation_status.sql',
    '003_remove_legacy_inventory.sql'],
});
function loadManifest(service) {
  if (!Object.hasOwn(manifests, service)) throw new Error('Unknown migration service');
  return manifests[service].map(filename => {
    const sql = fs.readFileSync(path.join(root, `${service}-service/migrations`, filename), 'utf8');
    return Object.freeze({filename, sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      // Authorization applies only with persisted fresh-test provenance, checked by runner.
      requiresFreshTest: service === 'catalog' && filename === '003_remove_legacy_inventory.sql',
      authorizedFreshTest: service === 'catalog' && filename === '003_remove_legacy_inventory.sql',
    });
  });
}
module.exports = {loadManifest};
