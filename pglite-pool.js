"use strict";
// Adapts a PGlite instance to the small part of the `pg` Pool interface this
// project actually uses.
//
// This is one implementation shared by the integration tests and the local
// sandbox database. It existed as a local helper inside the integration test
// file, which meant the sandbox and the tests could drift: a shape fix applied
// in one place would not reach the other, and the sandbox would start behaving
// differently from what the tests assert.
//
// The one behaviour worth knowing about is rowCount. PGlite reports the affected
// count in `affectedRows` and returns `rows: []` for a statement without a
// RETURNING clause, so a DELETE that matched rows would otherwise look like a
// 404. rowCount is taken from affectedRows when there are no rows to count.

function shapeResult(result) {
	return {
		rows: result.rows,
		rowCount: typeof result.affectedRows === "number" && result.rows.length === 0
			? result.affectedRows
			: result.rows.length,
		fields: result.fields,
	};
}

// Returns an object with the query/connect surface server.js and
// createOrderRouter expect from a pg Pool.
//
// A single PGlite instance is one database, so connect() returns a client bound
// to that same instance rather than a second connection. That is why the
// sandbox is safe for local use and unsafe for concurrent production traffic:
// transactions are serialised rather than isolated, which is acceptable for a
// single developer and is exactly what the tests already rely on.
function createPoolAdapter(db) {
	return {
		async query(sql, params = []) {
			const result = await db.query(sql, params);
			return shapeResult(result);
		},
		async connect() {
			return {
				async query(sql, params = []) {
					const result = await db.query(sql, params);
					return shapeResult(result);
				},
				release() {},
			};
		},
	};
}

module.exports = { createPoolAdapter, shapeResult };
