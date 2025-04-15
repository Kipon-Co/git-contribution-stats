# GitHub Activity Report

A library to generate activity reports for GitHub App installations. This library collects statistics about commits and pull requests across all repositories accessible by your GitHub App.

## Installation

```bash
npm install git-contribution-stats
```

## Usage

```typescript
import { generateGitHubReport } from 'git-contribution-stats'

// Generate a report
const report = await generateGitHubReport({
  app_id: 123456,              // Your GitHub App ID
  private_key: 'your-private-key',  // Your GitHub App private key
  days_to_look_back: 7           // Optional, defaults to 7 days
});

// Use the report data
console.log(report.summary);  // Formatted text report
console.log(report.detailed_results);  // Detailed data structure
```

## Features

- Collects commit and pull request activity for each User or Organization
- Works across all repositories and branchs accessible by your GitHub App
- Customizable time period for the report
- Detailed breakdown by user and repository
- Handles GitHub API rate limiting with automatic retries

## Report Data Structure

The report includes:
- A formatted text summary
- Detailed raw data for further processing

### Example Summary Output

```
📊 Statistics for my-org (Organization) - Last week:

👤 user1 (ID: 12345):
  Total: 15 commits, 3 PRs opened, 2 PRs closed
  Contributions by repository:
    - repo1: 10 commits, 2 PRs opened, 1 PRs closed
    - repo2: 5 commits, 1 PRs opened, 1 PRs closed

👤 user2 (ID: 67890):
  Total: 8 commits, 1 PRs opened, 1 PRs closed
  Contributions by repository:
    - repo1: 8 commits, 1 PRs opened, 1 PRs closed
```

## License

MIT