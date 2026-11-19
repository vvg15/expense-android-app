# Roadmap

Ideas agreed for later, roughly in priority order. Each should follow the upgrade rules in the README (add migrations, keep the bridge backward compatible, bump the version).

## Done
- 2.2.0: refreshed design, category budgets, refund handling, search across all months, Insights tab, dark/light choice.

## Next up
1. **Home screen widget.** "Spent this month" + quick **+ Add** button (Android App Widget; native code).
2. **Income & savings.** Optionally record salary/credit SMS as income; show monthly savings and savings rate.
3. **Monthly summary.** At the start of each month, a short recap of the previous one: top categories, biggest expenses, change vs the month before.

## Considered, not planned for now
- **Instant SMS detection** (as each message arrives, via RECEIVE_SMS). Google Play reviews this permission even more strictly, and the current "check when the app opens" already covers it well.
- **Rename categories.** Would need to update every past expense and rule; do with care if added.
