/* eslint-disable @n8n/community-nodes/no-restricted-imports -- tests are not published, so they may use the Node test runner */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeHelpers, NodeOperationError, type INodeParameters } from 'n8n-workflow';

import { IvantiNeuronsForItsm } from '../nodes/IvantiNeuronsForITSM/IvantiNeuronsForItsm.node';
import { description, execute } from '../nodes/IvantiNeuronsForITSM/actions/relationship/getRelated.operation';
import { fakeExecuteContext, page, type FakeResponse } from './context';

const recordId = '0123456789ABCDEF0123456789ABCDEF';
const url = `https://tenant.example.com/api/odata/businessobject/StandardUserTeams('${recordId}')/ProfileEmployeeAssociatedByStandardUserTeam`;
const base = {
	businessObject: 'StandardUserTeams',
	recordId,
	relationship: 'ProfileEmployeeAssociatedByStandardUserTeam',
	includeInputFields: false,
};

function run(typeVersion: number, responses: FakeResponse[], parameters: Record<string, unknown> = {}) {
	const { ctx, requests } = fakeExecuteContext({ typeVersion, responses, parameters: { ...base, ...parameters } });
	return { requests, result: execute.call(ctx) };
}

describe('Relationship › Get Related (#71)', () => {
	it('keeps the single request of versions 1 to 1.3', async () => {
		for (const typeVersion of [1, 1.1, 1.2, 1.3]) {
			const { requests, result } = run(typeVersion, [page(25)], { 'selectFields.fields': [{ name: 'LoginID' }] });
			assert.equal((await result).length, 25);
			assert.equal(requests.length, 1);
			assert.equal(requests[0].url, url);
			assert.deepEqual(requests[0].qs, { $select: 'LoginID' });
		}
	});

	it('reads every page on version 1.4, ordered by RecId', async () => {
		const { requests, result } = run(1.4, [page(100), page(100, 100), page(30, 200)]);
		const records = await result;
		assert.equal(records.length, 230);
		assert.equal(records[229].json.RecId, 'rec-229');
		assert.deepEqual(
			requests.map((r) => r.qs),
			[0, 100, 200].map(($skip) => ({ $orderby: 'RecId', $top: 100, $skip })),
		);
	});

	it('stops at Limit', async () => {
		const { requests, result } = run(1.4, [page(100), page(50, 100)], { returnAll: false, limit: 150 });
		assert.equal((await result).length, 150);
		assert.deepEqual(requests.map((r) => [r.qs?.$top, r.qs?.$skip]), [[100, 0], [50, 100]]);
	});

	it('sends the Manual fields', async () => {
		const { requests, result } = run(1.4, [page(2)], {
			returnAll: false,
			limit: 10,
			selectAllFields: false,
			'selectFields.fields': [{ name: 'LoginID' }],
			'odataFilter.odataFilter': [{ fieldName: 'Status', fieldType: 'string', operation: 'eq', value: 'Active', logicalOperator: 'and' }],
			orderBy: 'LoginID',
			orderDirection: 'desc',
		});
		await result;
		assert.deepEqual(requests[0].qs, {
			$select: 'LoginID',
			$filter: "Status eq 'Active'",
			$orderby: 'LoginID desc',
			$top: 10,
			$skip: 0,
		});
	});

	it('sends the OData Query (JSON) as on version 1.3, for example from an AI agent', async () => {
		const { requests, result } = run(1.4, [page(3)], {
			queryMode: 'json',
			odataQuery: { filter: "LoginID eq 'jdoe'", $select: ['RecId', 'LoginID'] },
		});
		assert.equal((await result).length, 3);
		assert.deepEqual(requests[0].qs, {
			$filter: "LoginID eq 'jdoe'",
			$select: 'RecId,LoginID',
			$orderby: 'RecId',
			$top: 100,
			$skip: 0,
		});
	});

	it('refuses paging options in the JSON query', async () => {
		const { requests, result } = run(1.4, [], { queryMode: 'json', odataQuery: '{"$top": 5}' });
		await assert.rejects(result, NodeOperationError);
		assert.equal(requests.length, 0);
	});

	it('returns nothing for "No instances found." or an empty answer', async () => {
		for (const response of [
			{ statusCode: 200, body: JSON.stringify({ value: 'No instances found.' }) },
			{ statusCode: 204, body: '' },
		]) {
			const { result } = run(1.4, [response]);
			assert.deepEqual(await result, []);
		}
	});

	it('keeps Include Input Fields: one item holding every page', async () => {
		const { ctx } = fakeExecuteContext({
			typeVersion: 1.4,
			responses: [page(100), page(5, 100)],
			parameters: { ...base, includeInputFields: true },
			inputItems: [{ json: { team: 'Service Desk' } }],
		});
		const [item] = await execute.call(ctx);
		assert.equal(item.json.team, 'Service Desk');
		assert.equal((item.json[base.relationship] as unknown[]).length, 105);
	});
});

describe('Get Related in the editor', () => {
	const values: INodeParameters = { resource: 'relationship', operation: 'getRelated', returnAll: true, queryMode: 'manual', selectAllFields: false };
	const shown = (typeVersion: number) =>
		description.filter((p) => NodeHelpers.displayParameter(values, p, { typeVersion }, null));
	const names = (typeVersion: number) => shown(typeVersion).map((p) => p.name);

	it('shows only Select Fields on versions 1 to 1.3', () => {
		for (const typeVersion of [1, 1.3]) {
			assert.deepEqual(names(typeVersion), ['businessObject', 'recordId', 'relationship', 'selectFields', 'includeInputFields']);
		}
	});

	it('shows Get Many query parameters on version 1.4, with Return All on by default', () => {
		const fields = names(1.4);
		for (const name of ['returnAll', 'queryMode', 'selectAllFields', 'selectFields', 'odataFilter', 'orderBy', 'orderDirection']) {
			assert.ok(fields.includes(name), name);
		}
		assert.ok(!fields.includes('useRawFilter'));
		assert.equal(shown(1.4).filter((p) => p.name === 'selectFields').length, 1);
		assert.equal(shown(1.4).find((p) => p.name === 'returnAll')?.default, true);
		const json = description.filter((p) =>
			p.name === 'odataQuery' && NodeHelpers.displayParameter({ ...values, queryMode: 'json' }, p, { typeVersion: 1.4 }, null));
		assert.equal(json.length, 1);
		assert.match(String(json[0].hint), /Expression/);
	});

	it('is version 1.4 of the node', () => {
		assert.deepEqual(new IvantiNeuronsForItsm().description.version, [1, 1.1, 1.2, 1.3, 1.4]);
	});
});
