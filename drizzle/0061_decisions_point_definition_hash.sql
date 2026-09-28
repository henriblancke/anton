-- A digest of the point's own definition at decide() time (instruction, question shape, escape
-- value, hard rules) so `agreement()` can restrict its evidence to the point's CURRENT definition,
-- not a predecessor's — a release can change a point's judgment logic while keeping its id and
-- model (PR #332 review). NULL on every row written before this column existed; `agreement()`
-- keeps those as evidence unconditionally rather than retroactively invalidating history it has
-- no prior definition to compare against.
ALTER TABLE `decisions` ADD `point_definition_hash` text;