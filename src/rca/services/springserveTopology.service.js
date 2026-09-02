import {
  getSupplyRouterTopology,
  getSupplyTag,
  getDemandTag,
} from "./springserve.service.js";

/* =========================================================
   Normalize demand tag
   ========================================================= */

function normalizeDemandTag(demandTag, routingConfig = {}) {
  if (!demandTag) {
    return null;
  }

  return {
    id: demandTag.id ?? null,
    name: demandTag.name ?? null,
    active: demandTag.active ?? null,

    demandPartnerId:
      demandTag.demand_partner_id ?? null,

    demandPartnerName:
      demandTag.demand_partner_name ??
      demandTag.demand_partner?.name ??
      null,

    priority:
      routingConfig.priority ?? null,

    tier:
      routingConfig.tier ?? null,

    locked:
      routingConfig.locked ?? false,

    ratio:
      routingConfig.ratio ?? null,

    slotNumber:
      routingConfig.slot_number ?? 0,

    slotOrder:
      routingConfig.slot_order ?? "n/a",

    rate:
      demandTag.rate ?? null,

    timeout:
      demandTag.timeout ?? null,

    format:
      demandTag.format ?? null,

    environment:
      demandTag.environment ?? null,

    raw: demandTag,
  };
}

/* =========================================================
   Get demand tags for a supply tag
   ========================================================= */

async function getDemandTagsForSupplyTag(supplyTag) {
  const demandTagPriorities =
    supplyTag?.demand_tag_priorities || [];

  if (!Array.isArray(demandTagPriorities)) {
    return [];
  }

  const demandTags = await Promise.all(
    demandTagPriorities.map(async (routingConfig) => {
      const demandTagId =
        routingConfig?.demand_tag_id;

      if (!demandTagId) {
        return null;
      }

      try {
        const demandTag =
          await getDemandTag(demandTagId);

        return normalizeDemandTag(
          demandTag,
          routingConfig
        );
      } catch (error) {
        console.error(
          `Failed to retrieve demand tag ${demandTagId}:`,
          error.message
        );

        return {
          id: demandTagId,
          name: null,
          active: null,
          demandPartnerId: null,
          demandPartnerName: null,

          priority:
            routingConfig.priority ?? null,

          tier:
            routingConfig.tier ?? null,

          locked:
            routingConfig.locked ?? false,

          ratio:
            routingConfig.ratio ?? null,

          slotNumber:
            routingConfig.slot_number ?? 0,

          slotOrder:
            routingConfig.slot_order ?? "n/a",

          error: error.message,
        };
      }
    })
  );

  return demandTags.filter(Boolean);
}

/* =========================================================
   Enrich one supply tag
   ========================================================= */

async function enrichSupplyTag(routerSupply) {
  const supplyTagId =
    routerSupply?.supply_tag_id;

  if (!supplyTagId) {
    return {
      supplyTagId: null,
      ratio:
        routerSupply?.ratio ?? null,

      fallbackSupplyTagId:
        routerSupply?.fallback_supply_tag_id ??
        null,

      owner: null,
      demandTags: [],
    };
  }

  const supplyTag =
    await getSupplyTag(supplyTagId);

  const demandTags =
    await getDemandTagsForSupplyTag(
      supplyTag
    );

  return {
    supplyTagId:
      supplyTag?.id ??
      supplyTagId,

    ratio:
      routerSupply?.ratio ??
      null,

    fallbackSupplyTagId:
      routerSupply?.fallback_supply_tag_id ??
      null,

    name:
      supplyTag?.name ??
      null,

    active:
      supplyTag?.active ??
      null,

    supplyPartnerId:
      supplyTag?.supply_partner_id ??
      null,

    supplyType:
      supplyTag?.supply_type ??
      null,

    environment:
      supplyTag?.environment ??
      null,

    format:
      supplyTag?.format ??
      null,

    rate:
      supplyTag?.rate ??
      null,

    owner:
      supplyTag?.name ??
      null,

    demandTags,

    raw: supplyTag,
  };
}

/* =========================================================
   Build normalized topology
   ========================================================= */

export function buildNormalizedTopology(springserve) {
  if (!springserve) {
    return {
      channelId: null,
      supplyRouterId: null,
      name: null,
      supplyPartnerId: null,
      supply: [],
      expectedDistribution: {
        supply: []
      }
    };
  }

  const supply = Array.isArray(springserve.supply)
    ? springserve.supply.map((s) => ({
        supplyTagId: s.supplyTagId ?? s.id ?? null,
        ratio: Number(s.ratio ?? 0),
        fallbackSupplyTagId: s.fallbackSupplyTagId ?? null,
        name: s.name ?? null,
        active: s.active ?? null,
        supplyPartnerId: s.supplyPartnerId ?? null,
        supplyType: s.supplyType ?? null,
        environment: s.environment ?? null,
        format: s.format ?? null,
        rate: s.rate ?? null,
        owner: s.owner ?? null,

        demandTags: Array.isArray(s.demandTags)
          ? s.demandTags.map((d) => ({
              id: d.id ?? d.demandTagId ?? null,
              name: d.name ?? null,
              active: d.active ?? null,
              demandPartnerId: d.demandPartnerId ?? null,
              demandPartnerName: d.demandPartnerName ?? null,
              priority: d.priority ?? null,
              tier: d.tier ?? null,
              locked: d.locked ?? null,
              ratio: d.ratio ?? null,
              slotNumber: d.slotNumber ?? null,
              slotOrder: d.slotOrder ?? null,
              rate: d.rate ?? null,
              timeout: d.timeout ?? null,
              format: d.format ?? null,
              environment: d.environment ?? null,
              raw: d.raw ?? null
            }))
          : []
      }))
    : [];

  return {
    channelId: springserve.channelId ?? null,
    supplyRouterId: String(
      springserve.supplyRouterId ?? springserve.id ?? ""
    ),
    name: springserve.name ?? null,
    supplyPartnerId:
      springserve.supplyPartnerId ??
      springserve.supply_partner_id ??
      null,

    supply,

    expectedDistribution: {
      supply: supply.map((s) => ({
        supplyTagId: s.supplyTagId,
        ratio: s.ratio
      }))
    }
  };
}

/* =========================================================
   Group demand tags by priority/tier for user selection

   Input: normalizedTopology.supply (array of supply tags,
   each with a demandTags array)

   Output: one row per supply tag, each holding its demand
   tags grouped by priority -> tier, so the RCA flow can ask
   "which priority/tier do you want to investigate?" and then
   list only the demand_tag_ids in that group.
   ========================================================= */

export function groupDemandTagsByPriorityTier(normalizedTopology) {
  const supply = normalizedTopology?.supply || [];

  return supply.map((supplyTag) => {
    const groups = {};

    for (const demandTag of supplyTag.demandTags || []) {
      const priority = demandTag.priority ?? "unknown";
      const tier = demandTag.tier ?? "unknown";
      const key = `priority_${priority}_tier_${tier}`;

      if (!groups[key]) {
        groups[key] = {
          priority,
          tier,
          demandTags: [],
        };
      }

      groups[key].demandTags.push({
        id: demandTag.id,
        name: demandTag.name,
        active: demandTag.active,
        demandPartnerName: demandTag.demandPartnerName,
        locked: demandTag.locked,
        ratio: demandTag.ratio,
        slotNumber: demandTag.slotNumber,
        slotOrder: demandTag.slotOrder,
      });
    }

    return {
      supplyTagId: supplyTag.supplyTagId,
      supplyTagName: supplyTag.name,
      ratio: supplyTag.ratio,
      priorityGroups: Object.values(groups).sort(
        (a, b) => a.priority - b.priority || a.tier - b.tier
      ),
    };
  });
}

/* =========================================================
   Complete SpringServe topology
   ========================================================= */

export async function getSpringServeTopology(
  supplyRouterId,
  options = {}
) {
  if (!supplyRouterId) {
    throw new Error(
      "supplyRouterId is required"
    );
  }

  /*
   * Get the supply router.
   */
  const router =
    await getSupplyRouterTopology(
      supplyRouterId
    );

  const supplyRatios =
    router?.supply_router_ratios || [];

  const supply = await Promise.all(
    supplyRatios.map(async (routerSupply) => {
      try {
        return await enrichSupplyTag(
          routerSupply
        );
      } catch (error) {
        console.error(
          `Failed to enrich supply tag ${routerSupply?.supply_tag_id}:`,
          error.message
        );

        return {
          supplyTagId:
            routerSupply?.supply_tag_id ??
            null,

          ratio:
            routerSupply?.ratio ??
            null,

          fallbackSupplyTagId:
            routerSupply?.fallback_supply_tag_id ??
            null,

          owner: null,

          demandTags: [],

          error: error.message,
        };
      }
    })
  );

  const rawTopology = {
    channelId:
      options.channelId ?? null,

    supplyRouterId:
      String(
        router?.id ??
        supplyRouterId ??
        ""
      ),

    name:
      router?.name ?? null,

    supplyPartnerId:
      router?.supply_partner_id ?? null,

    supply,
  };

  const normalized = buildNormalizedTopology(rawTopology);

  return {
    id:
      router?.id ??
      Number(supplyRouterId),

    accountId:
      router?.account_id ??
      null,

    name:
      router?.name ??
      null,

    active:
      router?.active ??
      null,

    supplyPartnerId:
      router?.supply_partner_id ??
      null,

    environment:
      router?.environment ??
      null,

    normalized,

    raw: router,

    ...normalized,
  };
}

export default getSpringServeTopology;