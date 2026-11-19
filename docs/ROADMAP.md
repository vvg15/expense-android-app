# Roadmap

Ideas agreed for later, roughly in priority order. Each should follow the upgrade rules in the README (add migrations, keep the bridge backward compatible, bump the version).

## Next up
1. **Category budgets.** A monthly limit per category (e.g. Food ₹6,000) with progress bars on Home and a warning at 80% / 100%.
2. **Refund handling.** Recognise refund / reversal SMS and subtract them from the original purchase (match by merchant and amount within ~30 days) instead of ignoring them.
3. **Search across all months.** The Home search currently looks only at the month on screen. Add an "All time" toggle or a separate search screen with date range.

## Later
4. **Home screen widget.** "Spent this month" + quick **+ Add** button (Android App Widget; native code).
5. **Income & savings.** Optionally record salary/credit SMS as income; show monthly savings and savings rate.
6. **Monthly summary.** At the start of each month, a short recap of the previous one: top categories, biggest expenses, change vs the month before.

## Considered, not planned for now
- **Instant SMS detection** (as each message arrives, via RECEIVE_SMS). Google Play reviews this permission even more strictly, and the current "check when the app opens" already covers it well.
- **Rename categories.** Would need to update every past expense and rule; do with care if added.
