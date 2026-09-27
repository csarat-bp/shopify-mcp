import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

const CreateCollectionInputSchema = z.object({
  title: z.string().min(1).describe("Collection title, e.g. 'Bat Grips'"),
  handle: z.string().optional().describe("URL slug. Auto-generated from title if omitted."),
  descriptionHtml: z.string().optional(),
  sortOrder: z
    .enum([
      "ALPHA_ASC",
      "ALPHA_DESC",
      "BEST_SELLING",
      "CREATED",
      "CREATED_DESC",
      "MANUAL",
      "PRICE_ASC",
      "PRICE_DESC",
    ])
    .optional()
    .describe("How products are sorted in the collection"),
  ruleSet: z
    .object({
      appliedDisjunctively: z
        .boolean()
        .default(false)
        .describe("true = product matches ANY rule; false = must match ALL rules"),
      rules: z
        .array(
          z.object({
            column: z
              .string()
              .describe("Rule column, e.g. TYPE, VENDOR, TAG, TITLE, VARIANT_PRICE, PRODUCT_CATEGORY_ID"),
            relation: z
              .string()
              .describe("Rule relation, e.g. EQUALS, NOT_EQUALS, CONTAINS, STARTS_WITH, GREATER_THAN, LESS_THAN"),
            condition: z.string().describe("Value to compare against, e.g. 'Bat Grips'"),
          }),
        )
        .min(1),
    })
    .optional()
    .describe("Rules for a smart (automated) collection. Omit for a manual collection."),
  productIds: z
    .array(z.string())
    .optional()
    .describe("Product GIDs to add (manual collections only; ignored when ruleSet is given)"),
  publishToOnlineStore: z
    .boolean()
    .default(false)
    .describe(
      "Also publish the collection to the Online Store sales channel (needs the write_publications scope)",
    ),
});
type CreateCollectionInput = z.infer<typeof CreateCollectionInputSchema>;

let shopifyClient: GraphQLClient;

const createCollection = {
  name: "create-collection",
  description:
    "Create a manual or smart (rule-based) collection, optionally publishing it to the Online Store.",
  schema: CreateCollectionInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CreateCollectionInput) => {
    try {
      const { publishToOnlineStore, productIds, ruleSet, ...fields } = input;

      const mutation = gql`
        #graphql

        mutation collectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection {
              id
              title
              handle
              sortOrder
              productsCount {
                count
              }
              ruleSet {
                appliedDisjunctively
                rules {
                  column
                  relation
                  condition
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const collectionInput: Record<string, unknown> = { ...fields };
      if (ruleSet) {
        collectionInput.ruleSet = ruleSet;
      } else if (productIds?.length) {
        collectionInput.products = productIds;
      }

      const data = (await shopifyClient.request(mutation, { input: collectionInput })) as {
        collectionCreate: {
          collection: any;
          userErrors: Array<{ field: string; message: string }>;
        };
      };
      checkUserErrors(data.collectionCreate.userErrors, "create collection");
      const collection = data.collectionCreate.collection;

      let published: { onlineStore: boolean; error?: string } | undefined;
      if (publishToOnlineStore) {
        published = await publishToStore(collection.id);
      }

      return {
        collection: {
          id: collection.id,
          title: collection.title,
          handle: collection.handle,
          sortOrder: collection.sortOrder,
          productsCount: collection.productsCount?.count ?? null,
          ruleSet: collection.ruleSet,
        },
        ...(published && { published }),
      };
    } catch (error) {
      handleToolError("create collection", error);
    }
  },
};

// Publishing is best-effort: the collection is already created, so a missing
// write_publications scope is reported instead of failing the whole call.
async function publishToStore(
  collectionId: string,
): Promise<{ onlineStore: boolean; error?: string }> {
  try {
    const pubs = (await shopifyClient.request(gql`
      #graphql

      query onlineStorePublication {
        publications(first: 20) {
          nodes {
            id
            name
          }
        }
      }
    `)) as { publications: { nodes: Array<{ id: string; name: string }> } };

    const onlineStore = pubs.publications.nodes.find((p) => p.name === "Online Store");
    if (!onlineStore) {
      return { onlineStore: false, error: "Online Store publication not found" };
    }

    const res = (await shopifyClient.request(
      gql`
        #graphql

        mutation publishCollection($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { id: collectionId, input: [{ publicationId: onlineStore.id }] },
    )) as { publishablePublish: { userErrors: Array<{ field: string; message: string }> } };

    const errs = res.publishablePublish.userErrors;
    if (errs.length) {
      return { onlineStore: false, error: errs.map((e) => e.message).join(", ") };
    }
    return { onlineStore: true };
  } catch (error) {
    return { onlineStore: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export { createCollection };
