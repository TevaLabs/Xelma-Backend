import { Router, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { requireAdmin } from '../middleware/auth.middleware';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     summary: List users, optionally filtered by role (paginated)
 *     description: Returns a page of users ordered by newest first. Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [USER, ADMIN, ORACLE]
 *         description: Only return users with this role
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Paginated user list
 *       400:
 *         description: Invalid role, page or limit
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { role, page: pageRaw, limit: limitRaw } = req.query;

    let roleFilter: UserRole | undefined;
    if (role !== undefined) {
      if (typeof role !== 'string' || !(Object.values(UserRole) as string[]).includes(role)) {
        return res.status(400).json({
          error: `Invalid role. Must be one of: ${Object.values(UserRole).join(', ')}`,
        });
      }
      roleFilter = role as UserRole;
    }

    const page = pageRaw === undefined ? 1 : Number(pageRaw);
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({ error: 'page and limit must be positive integers' });
    }
    const take = Math.min(limit, MAX_LIMIT);

    const where = roleFilter ? { role: roleFilter } : {};
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * take,
        take,
        select: {
          id: true,
          walletAddress: true,
          role: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ]);

    return res.json({
      users,
      pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) },
    });
  } catch (err) {
    logger.error('Admin user list failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

export default router;
