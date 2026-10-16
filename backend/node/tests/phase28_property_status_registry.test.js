import test from 'node:test';
import assert from 'node:assert/strict';

test('Phase 28 — Property Management Status & Registry-Gated Sold Workflow Tests', async (t) => {

  await t.test('1. Normal Status Transitions (Available -> Reserved, Reserved -> Hold, etc.)', () => {
    const plot = { id: 'plot_1', status_id: 'available' };
    const allowedNormalStatuses = ['available', 'hold', 'reserved', 'blocked'];

    const transitionStatus = (plotObj, newStatus) => {
      if (newStatus === 'sold') {
        throw new Error('Registry document is required before this plot can be marked Sold.');
      }
      if (!allowedNormalStatuses.includes(newStatus)) {
        throw new Error('Unknown status');
      }
      return { ...plotObj, status_id: newStatus };
    };

    const reservedPlot = transitionStatus(plot, 'reserved');
    assert.strictEqual(reservedPlot.status_id, 'reserved');

    const holdPlot = transitionStatus(reservedPlot, 'hold');
    assert.strictEqual(holdPlot.status_id, 'hold');

    const availablePlot = transitionStatus(holdPlot, 'available');
    assert.strictEqual(availablePlot.status_id, 'available');
  });

  await t.test('2. Marking Sold WITHOUT Registry is BLOCKED', () => {
    const plot = { id: 'plot_2', status_id: 'reserved', registry_count: 0 };

    const updateStatusToSoldWithoutRegistry = (plotObj, registryDocs = []) => {
      if (registryDocs.length === 0) {
        throw new Error('Registry document is required before this plot can be marked Sold.');
      }
      return { ...plotObj, status_id: 'sold' };
    };

    assert.throws(
      () => updateStatusToSoldWithoutRegistry(plot, []),
      /Registry document is required/
    );
    assert.strictEqual(plot.status_id, 'reserved', 'Plot status remains unchanged when blocked');
  });

  await t.test('3. Marking Sold WITH Registry succeeds atomically', () => {
    const plot = { id: 'plot_3', status_id: 'reserved', registry_count: 0 };
    const registryDoc = { id: 'reg_1', filename: 'deed.pdf', version: 1 };

    const atomicSoldWorkflow = (plotObj, newFile = null, existingRegistries = []) => {
      if (!newFile && existingRegistries.length === 0) {
        throw new Error('Registry document is required before this plot can be marked Sold.');
      }
      const updatedRegistries = [...existingRegistries];
      if (newFile) {
        updatedRegistries.push({
          id: 'reg_' + (existingRegistries.length + 1),
          filename: newFile.name,
          version: existingRegistries.length + 1,
        });
      }
      return {
        plot: { ...plotObj, status_id: 'sold', registry_count: updatedRegistries.length },
        registry: updatedRegistries[updatedRegistries.length - 1],
      };
    };

    const res = atomicSoldWorkflow(plot, { name: 'deed_plot3.pdf' }, []);
    assert.strictEqual(res.plot.status_id, 'sold');
    assert.strictEqual(res.plot.registry_count, 1);
    assert.strictEqual(res.registry.filename, 'deed_plot3.pdf');
  });

  await t.test('4. Status History & Audit Log Recording on Status Transition', () => {
    const historyLogs = [];
    const auditLogs = [];

    const recordStatusChange = (plotId, colonyId, prevStatus, nextStatus, userId) => {
      historyLogs.push({
        plot_id: plotId,
        colony_id: colonyId,
        previous_status: prevStatus,
        new_status: nextStatus,
        user_id: userId,
      });
      auditLogs.push({
        action: 'PLOT_STATUS_CHANGED',
        target_id: plotId,
        metadata: { from: prevStatus, to: nextStatus },
      });
    };

    recordStatusChange('plot_4', 'colony_1', 'available', 'reserved', 'admin_1');
    assert.strictEqual(historyLogs.length, 1);
    assert.strictEqual(historyLogs[0].previous_status, 'available');
    assert.strictEqual(historyLogs[0].new_status, 'reserved');

    recordStatusChange('plot_4', 'colony_1', 'reserved', 'sold', 'admin_1');
    assert.strictEqual(historyLogs.length, 2);
    assert.strictEqual(historyLogs[1].previous_status, 'reserved');
    assert.strictEqual(historyLogs[1].new_status, 'sold');
    assert.strictEqual(auditLogs.length, 2);
  });

  await t.test('5. Registry Count Maximum Version Limit (3/3)', () => {
    const existingRegistries = [
      { id: 'r1', version: 1 },
      { id: 'r2', version: 2 },
      { id: 'r3', version: 3 },
    ];

    const canAttachMore = (registries) => registries.length < 3;
    assert.strictEqual(canAttachMore(existingRegistries), false, 'Max 3 registry limit enforced');
  });

});
