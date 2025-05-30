import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "../..";
import { saveConfig } from "../../../../../config";
import { GameObjectDefs } from "../../../../../shared/defs/gameObjectDefs";
import { MapDefs } from "../../../../../shared/defs/mapDefs";
import { TeamMode } from "../../../../../shared/gameConfig";
import { serverConfigPath } from "../../../config";
import { type SaveGameBody, zUpdateRegionBody } from "../../../utils/types";
import { server } from "../../apiServer";
import {
    databaseEnabledMiddleware,
    privateMiddleware,
    validateParams,
} from "../../auth/middleware";
import { getRedisClient } from "../../cache";
import { leaderboardCache } from "../../cache/leaderboard";
import { db } from "../../db";
import {
    type MatchDataTable,
    itemsTable,
    matchDataTable,
    usersTable,
} from "../../db/schema";
import { MOCK_USER_ID } from "../user/auth/mock";
import { ModerationRouter, logPlayerIPs } from "./ModerationRouter";

export const PrivateRouter = new Hono<Context>();

PrivateRouter.use(privateMiddleware);

PrivateRouter.route("/moderation", ModerationRouter);

PrivateRouter.post("/update_region", validateParams(zUpdateRegionBody), (c) => {
    try {
        const { regionId, data } = c.req.valid("json");

        server.updateRegion(regionId, data);
        return c.json({}, 200);
    } catch (err) {
        server.logger.warn("/private/update_region: Error processing request", err);
        return c.json({ error: "Error processing request" }, 500);
    }
});

PrivateRouter.post(
    "/set_game_mode",
    validateParams(
        z.object({
            index: z.number(),
            teamMode: z.nativeEnum(TeamMode),
            mapName: z.string(),
            enabled: z.boolean().default(true),
        }),
    ),
    (c) => {
        try {
            const { index, mapName, teamMode, enabled } = c.req.valid("json");

            if (!MapDefs[mapName as keyof typeof MapDefs]) {
                return c.json({ error: "Invalid map name" }, 400);
            }

            if (!server.modes[index]) {
                return c.json({ error: "Invalid mode index" }, 400);
            }

            server.modes[index] = {
                mapName: mapName as keyof typeof MapDefs,
                teamMode,
                enabled,
            };

            saveConfig(serverConfigPath, {
                modes: server.modes,
            });

            return c.json({}, 200);
        } catch (err) {
            server.logger.warn("set_game_mode Error processing request", err);
            return c.json({ error: "Error processing request" }, 500);
        }
    },
);

PrivateRouter.post("/save_game", databaseEnabledMiddleware, async (c) => {
    try {
        const data = (await c.req.json()) as SaveGameBody;

        const matchData = data.matchData;

        if (!matchData.length) {
            return c.json({ error: "Empty match data" }, 500);
        }

        await leaderboardCache.invalidateCache(matchData);

        await db.insert(matchDataTable).values(matchData);
        await logPlayerIPs(matchData);
        server.logger.log(`Saved game data for ${matchData[0].gameId}`);
        return c.json({}, 200);
    } catch (err) {
        server.logger.warn("save_game Error processing request", err);
        return c.json({ error: "Error processing request" }, 500);
    }
});

PrivateRouter.post(
    "/give_item",
    databaseEnabledMiddleware,
    validateParams(
        z.object({
            item: z.string(),
            slug: z.string(),
            source: z.string().default("daddy-has-privileges"),
        }),
    ),
    async (c) => {
        try {
            const { item, slug, source } = c.req.valid("json");

            const def = GameObjectDefs[item];

            if (!def) {
                return c.json({ error: "Invalid item type" }, 400);
            }

            const userId = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: {
                    id: true,
                },
            });

            if (!userId) {
                return c.json({ error: "User not found" }, 404);
            }

            const existing = await db.query.itemsTable.findFirst({
                where: and(eq(itemsTable.userId, userId.id), eq(itemsTable.type, item)),
                columns: {
                    type: true,
                },
            });

            if (existing) {
                return c.json({ error: "User already has item" }, 400);
            }

            await db.insert(itemsTable).values({
                userId: userId.id,
                type: item,
                source,
                timeAcquired: Date.now(),
            });

            return c.json({ success: true }, 200);
        } catch (err) {
            server.logger.warn("/private/give_item: Error unlocking item", err);
            return c.json({}, 500);
        }
    },
);

PrivateRouter.post(
    "/remove_item",
    databaseEnabledMiddleware,
    validateParams(
        z.object({
            item: z.string(),
            slug: z.string(),
        }),
    ),
    async (c) => {
        try {
            const { item, slug } = c.req.valid("json");

            const user = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: {
                    id: true,
                },
            });

            if (!user) {
                return c.json({ error: "User not found" }, 404);
            }

            await db
                .delete(itemsTable)
                .where(and(eq(itemsTable.userId, user.id), eq(itemsTable.type, item)));

            return c.json({ success: true }, 200);
        } catch (err) {
            server.logger.warn("/private/remove_item: Error removing item", err);
            return c.json({}, 500);
        }
    },
);

PrivateRouter.post("/clear_cache", async (c) => {
    try {
        const client = await getRedisClient();
        await client.flushAll();
        return c.json({ success: true }, 200);
    } catch (err) {
        server.logger.warn("/private/clear_cache: Error clearing cache", err);
        return c.json({}, 500);
    }
});

PrivateRouter.post(
    "/test/insert_game",
    databaseEnabledMiddleware,
    validateParams(
        z.object({
            kills: z.number().catch(1),
        }),
    ),
    async (c) => {
        try {
            const data = c.req.valid("json");
            const matchData: MatchDataTable = {
                ...{
                    gameId: crypto.randomUUID(),
                    userId: MOCK_USER_ID,
                    createdAt: new Date(),
                    region: "na",
                    mapId: 0,
                    mapSeed: 9834567801234,
                    username: MOCK_USER_ID,
                    playerId: 9834,
                    teamMode: TeamMode.Solo,
                    teamCount: 4,
                    teamTotal: 25,
                    teamId: 7,
                    timeAlive: 842,
                    rank: 3,
                    died: true,
                    kills: 5,
                    damageDealt: 1247,
                    damageTaken: 862,
                    killerId: 18765,
                    killedIds: [12543, 13587, 14298, 15321, 16754],
                },
                ...data,
            };
            await leaderboardCache.invalidateCache([matchData]);
            await db.insert(matchDataTable).values(matchData);
            return c.json({ success: true }, 200);
        } catch (err) {
            server.logger.warn("/private/test/insert_game: Error inserting game", err);
            return c.json({}, 500);
        }
    },
);
