#!/bin/bash
set -e

# Add changes
git add prisma/schema.prisma
git add src/routes/auth.routes.ts
git add src/index.ts
git add src/routes/user.routes.ts
git add docs/USER_MANAGEMENT_FEATURES.md

# Commit
git commit -m "feat: Implement user profile, balance management and daily login bonus

- Update Prisma schema: Add User profile fields, Transaction model, remove duplicates
- Implement Daily Login Bonus in auth.routes (Streak + Multipliers)
- Add user.routes for Profile, Balance, Stats, and Transactions
- Update index.ts to register new user routes
- Add documentation in docs/USER_MANAGEMENT_FEATURES.md

Resolves #35"

echo "Changes committed successfully!"
