-- Flow graphs move from entryBlockId to the Flow input block (docs/decisions/flow-input-block.md).
-- The former entry Agent becomes the only target, and the block is placed 280 left of it
-- (clamped at 0, same y). A draft without an entry gets an unconnected block at (40, 50).
UPDATE flows SET graph_json = json_remove(
  json_set(graph_json, '$.flowInput', json_object(
    'position', json_object(
      'x', COALESCE(
        (SELECT max(json_extract(b.value, '$.position.x') - 280, 0)
          FROM json_each(graph_json, '$.blocks') b
          WHERE json_extract(b.value, '$.id') = json_extract(graph_json, '$.entryBlockId')),
        40),
      'y', COALESCE(
        (SELECT json_extract(b.value, '$.position.y')
          FROM json_each(graph_json, '$.blocks') b
          WHERE json_extract(b.value, '$.id') = json_extract(graph_json, '$.entryBlockId')),
        50)),
    'targetBlockIds', CASE WHEN json_extract(graph_json, '$.entryBlockId') IS NULL
      THEN json_array() ELSE json_array(json_extract(graph_json, '$.entryBlockId')) END)),
  '$.entryBlockId')
-- statement-breakpoint
-- Snapshots stay immutable: the trigger is lifted only for this shape rewrite, which
-- keeps every recorded block, connection, Agent and reporting protocol unchanged.
DROP TRIGGER immutable_run_snapshot_update
-- statement-breakpoint
UPDATE run_snapshots SET snapshot_json = json_remove(
  json_set(snapshot_json, '$.flow.graph.flowInput', json_object(
    'position', json_object(
      'x', COALESCE(
        (SELECT max(json_extract(b.value, '$.position.x') - 280, 0)
          FROM json_each(snapshot_json, '$.flow.graph.blocks') b
          WHERE json_extract(b.value, '$.id') = json_extract(snapshot_json, '$.flow.graph.entryBlockId')),
        40),
      'y', COALESCE(
        (SELECT json_extract(b.value, '$.position.y')
          FROM json_each(snapshot_json, '$.flow.graph.blocks') b
          WHERE json_extract(b.value, '$.id') = json_extract(snapshot_json, '$.flow.graph.entryBlockId')),
        50)),
    'targetBlockIds', CASE WHEN json_extract(snapshot_json, '$.flow.graph.entryBlockId') IS NULL
      THEN json_array() ELSE json_array(json_extract(snapshot_json, '$.flow.graph.entryBlockId')) END)),
  '$.flow.graph.entryBlockId')
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_update BEFORE UPDATE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END
