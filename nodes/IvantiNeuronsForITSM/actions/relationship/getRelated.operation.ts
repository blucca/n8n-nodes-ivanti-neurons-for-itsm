
import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { NodeOperationError, updateDisplayOptions } from 'n8n-workflow';

import { extractValueArray, ivantiApiRequest } from '../../transports'
import { odataListProperties } from '../../odata/queryProperties';
import { buildODataQuery } from '../../odata/queryBuilder';
import { continueOnFailItem, itemError } from '../itemErrors';
import { getOverrideHeaders } from '../requestOptions';
import { assertSafeFieldName, assertSafePathSegment, assertSafeRecordId, validateBusinessObject } from '../../common';


/**
 * UI property definitions for the **Relationship → Get Related** operation.
 *
 * Exposes:
 * - `businessObject` – plural OData entity name of the source record
 * - `recordId` – GUID of the source record
 * - `relationship` – relationship name to traverse (e.g. `IncidentToChange`)
 * - `selectFields` – optional field projection for the related records (version 1 to 1.3)
 * - from version 1.4, Get Many's query parameters (`returnAll`, `limit`, `queryMode`,
 *   `odataQuery`, the Manual fields), so a relationship of any size is read page by page
 * - `includeInputFields` – when true, merges related records into the input item
 *   under a key named after the relationship, instead of emitting separate items
 */
/** Shows a parameter only on node version 1.4 and later. */
const FROM_V1_4 = [{ _cnd: { gte: 1.4 } }];
/** Shows a parameter only on node versions before 1.4 (kept for existing workflows). */
const BEFORE_V1_4 = [{ _cnd: { lt: 1.4 } }];

/** Get Many's parameters that exist only on version 1 ("Define Filter as JSON"). */
const VERSION_1_ONLY = ['useRawFilter', 'rawFilter'];

/**
 * Get Many's query parameters, shown on Get Related from version 1.4: Return All
 * (on by default, since the operation is meant to read the whole relationship),
 * Limit, Mode, OData Query (JSON) as on version 1.3, and the Manual fields.
 */
const queryProperties: INodeProperties[] = odataListProperties
	.filter((property) => !VERSION_1_ONLY.includes(property.name))
	// Of the two "OData Query (JSON)" definitions keep the one for version 1.3 and later.
	.filter((property) => property.name !== 'odataQuery' || property.hint !== undefined)
	.map((property) => ({
		...property,
		...(property.name === 'returnAll' ? { default: true } : {}),
		displayOptions: {
			...property.displayOptions,
			show: { ...property.displayOptions?.show, '@version': FROM_V1_4 },
		},
	}));

export const properties: INodeProperties[] = [
	{
		displayName: "Business Object",
		name: "businessObject",
		type: "string",
		default: "",
		required: true,
		noDataExpression: false,
		description: "The business object to retrieve. Must be the plural OData collection name (e.g. 'Incidents', 'Changes').",
		placeholder: "Incidents",
	},
	//record id
	{
		displayName: "Record ID",
		name: "recordId",
		type: "string",
		default: "",
		required: true,
		description: "The record ID to link. The Guid format is '07E1BD1BF5804E67B8E76B26FA6EF9A0'.",
	},
	{
		displayName: "Relationship",
		name: "relationship",
		type: "string",
		default: "",
		required: true,
		description: "The relationship to link. e.g., 'IncidentToChange'.",
	},
	{
		displayName: 'Select Fields',
		name: 'selectFields',
		placeholder: 'Add Select Field',
		type: 'fixedCollection',
		default: [],
		typeOptions: {
			multipleValues: true,
		},
		description: 'The fields to select from the relationship. e.g., "Name".',
		displayOptions: { show: { '@version': BEFORE_V1_4 } },
		options: [
			{
				name: 'fields',
				displayName: 'Field',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: 'Name',

					},
				],
			},
		],
	},
	...queryProperties,
	//include input fields
	{
		displayName: 'Include Input Fields',
		name: 'includeInputFields',
		type: 'boolean',
		default: false,
		description: 'Whether to include the input fields in the response. If true, the input fields will be included in the response.',
	},

]
const displayOptions = {
	show: {
		resource: ['relationship'],
		operation: ['getRelated'],
	},
};

export const description = updateDisplayOptions(displayOptions, properties);



/** Records per page when reading a relationship page by page (version 1.4+). */
const PAGE_SIZE = 100;

/**
 * One page of related records. Ivanti answers "no related records" either with
 * the text "No instances found." in `value` or with an empty body (HTTP 204).
 */
async function readPage(this: IExecuteFunctions, url: string, qs: IDataObject, headers: IDataObject): Promise<IDataObject[]> {
	const response = await ivantiApiRequest.call(this, 'GET', url, qs, undefined, headers);
	return response && typeof response.value === 'string' && response.value.includes('No instances found.')
		? []
		: extractValueArray.call(this, response);
}

/**
 * Versions 1 to 1.3: a single request with only `$select`. Ivanti returns its
 * default page of 25 records (#71); kept so saved workflows do not change.
 */
async function readFirstPage(this: IExecuteFunctions, url: string, itemIndex: number, headers: IDataObject): Promise<IDataObject[]> {
	const selectFieldsCollection = this.getNodeParameter('selectFields.fields', itemIndex, []) as { name: string }[];
	selectFieldsCollection.forEach(field => assertSafeFieldName.call(this, field.name));
	const qs: IDataObject = {};
	if (selectFieldsCollection.length !== 0) {
		qs['$select'] = selectFieldsCollection.map(field => field.name).join(',');
	}
	return readPage.call(this, url, qs, headers);
}

/**
 * Version 1.4+: the query from Get Many's parameters (`buildODataQuery`), read
 * with `$top`/`$skip` until Ivanti returns a short page or Limit is reached.
 * Without an order of its own the query is ordered by `RecId`, so that pages
 * neither overlap nor skip records (#4).
 */
async function readRelatedPages(this: IExecuteFunctions, url: string, itemIndex: number, headers: IDataObject): Promise<IDataObject[]> {
	const query = buildODataQuery.call(this, itemIndex);
	if (query['$orderby'] === undefined) query['$orderby'] = 'RecId';
	const returnAll = this.getNodeParameter('returnAll', itemIndex, true) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const records: IDataObject[] = [];
	while (records.length < limit) {
		const top = Math.min(PAGE_SIZE, limit - records.length);
		const page = await readPage.call(this, url, { ...query, $top: top, $skip: records.length }, headers);
		records.push(...page);
		if (page.length < top) break;
	}
	return records;
}

/**
 * Executes the **Relationship → Get Related** operation.
 *
 * Issues `GET /odata/businessobject/{object}('{recordId}')/{relationship}` and
 * returns the related records: the first page on versions 1 to 1.3, every page
 * (or up to Limit) on version 1.4 and later. When the API responds with "No instances found."
 * the result is normalised to an empty array rather than throwing.
 *
 * When `includeInputFields` is `true`, each output item merges the input item's
 * JSON with a `{relationship}: [...]` key instead of emitting one item per related record.
 *
 * @throws {NodeOperationError} when `recordId` is empty
 */
export async function execute(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const returnData: INodeExecutionData[] = [];
	for (let i = 0; i < items.length; i++) {
		try {
			const recordId = this.getNodeParameter('recordId', i) as string;
			if (recordId === '') {
				throw new NodeOperationError(this.getNode(), 'The "Record ID" parameter is required!');
			}
			const relationship = this.getNodeParameter('relationship', i) as string;
			const businessObject = this.getNodeParameter('businessObject', i) as string;

			validateBusinessObject.call(this, businessObject);

			assertSafePathSegment.call(this, businessObject, 'Business Object');
			assertSafePathSegment.call(this, relationship, 'Relationship');
			assertSafeRecordId.call(this, recordId);
			const includeInputFields = this.getNodeParameter('includeInputFields', i) as boolean;
			const url = `/odata/businessobject/${businessObject}('${encodeURIComponent(recordId)}')/${relationship}`;
			const headers = getOverrideHeaders.call(this, i);
			const related = this.getNode().typeVersion >= 1.4
				? await readRelatedPages.call(this, url, i, headers)
				: await readFirstPage.call(this, url, i, headers);
			let executionData: INodeExecutionData[] = [];
			if (includeInputFields) {
				executionData.push(
					{
						json: {
							...items[i].json,
							[`${relationship}`]: related,
						},
						pairedItem: { item: i },
					}
				)
			} else {
				executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(related),
					{ itemData: { item: i } },
				);
			}
			returnData.push(...executionData);
		} catch (error) {
			if (this.continueOnFail()) {
				returnData.push(continueOnFailItem(error, i));
			}
			else {
				throw itemError.call(this, error, i);
			}
		}
	}
	return returnData;
}



/** Shape of the OData response returned by relationship traversal endpoints. */
export interface GetRelatedResponse {
	"@odata.context": string
	value: IDataObject[]
}
