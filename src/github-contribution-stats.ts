import { App } from "octokit"

export interface GitHubActivityConfig {
    app_id: number
    private_key: string
    days_to_look_back?: number
}

export interface UserStat {
    name: string
    user_id: string | null
    total_commits: number
    total_prs_opened: number
    total_prs_closed: number
    repo_contributions: RepoContribution[]
}

export interface RepoContribution {
    repo_name: string
    commits: number
    prs_opened: number
    prs_closed: number
}

export interface InstallationStats {
    id: number
    account: string
    account_type: string
    period_days: number
    user_stats: UserStat[]
}

export interface InstallationError {
    id: number
    account: string
    error: string
}

export interface GitHubActivityResult {
    summary: string
    detailed_results: (InstallationStats | InstallationError)[]
}

export async function generateGitHubReport(config: GitHubActivityConfig): Promise<GitHubActivityResult> {
    const { app_id, private_key, days_to_look_back = 7 } = config

    const app = await initializeGitHubApp(app_id, private_key)
    try {
        const installations = await getInstallations(app)
        console.log(`Found ${installations.length} installations`)

        const results = await processInstallations(app, installations, days_to_look_back)
        const report = generateReport(results)

        return {
            summary: report,
            detailed_results: results
        }
    } catch (error: any) {
        console.error("Error accessing GitHub API:", error)
        throw error
    }
}

async function initializeGitHubApp(app_id: number, private_key: string) {
    return new App({
        appId: app_id,
        privateKey: private_key,
    })
}

async function getInstallations(app: any) {
    const response = await app.octokit.request('GET /app/installations', {
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    })
    return response.data
}

async function processInstallations(app: any, installations: any[], days_to_look_back: number) {
    const results = []

    for (const installation of installations) {
        try {
            const octokit = await app.getInstallationOctokit(installation.id)
            const repos = await getRepositories(octokit)
            console.log(`Installation ${installation.id} has access to ${repos.length} repositories`)

            const cutoff_date = calculateCutoffDate(days_to_look_back)
            const updated_repos = filterUpdatedRepositories(repos, cutoff_date)
            console.log(`${updated_repos.length} of ${repos.length} repositories were updated in the specified period`)

            const user_stats = await collectUserStats(octokit, updated_repos, cutoff_date)
            const installation_stats = formatInstallationStats(installation, days_to_look_back, user_stats)

            results.push(installation_stats)
        } catch (error: any) {
            console.error(`Error processing installation ${installation.id}: ${error.message}`)
            results.push({
                id: installation.id,
                account: installation.account.login,
                error: error.message
            })
        }
    }

    return results
}

async function getRepositories(octokit: any) {
    const { data: { repositories } } = await octokit.request('GET /installation/repositories', {
        per_page: 100,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    })
    return repositories
}

function calculateCutoffDate(days_to_look_back: number) {
    const cutoff_date = new Date()
    cutoff_date.setDate(cutoff_date.getDate() - days_to_look_back)
    return cutoff_date
}

function filterUpdatedRepositories(repos: any[], cutoff_date: Date) {
    return repos.filter(repo => {
        const last_pushed = new Date(repo.pushed_at || 0)
        const last_updated = new Date(repo.updated_at || 0)
        const latest_activity = last_pushed > last_updated ? last_pushed : last_updated

        const was_updated_in_period = latest_activity >= cutoff_date
        if (!was_updated_in_period) {
            console.log(`Skipping repository ${repo.full_name} - no updates since ${cutoff_date.toISOString()}`)
        }
        return was_updated_in_period
    })
}

async function collectUserStats(octokit: any, updated_repos: any[], cutoff_date: Date) {
    const user_stats: any = {}
    const since = cutoff_date.toISOString()

    for (const repo of updated_repos) {
        try {
            const processed_commits = new Set<string>()
            const repo_name = repo.name

            await processRepositoryBranches(octokit, repo, since, cutoff_date, processed_commits, user_stats)
            await processRepositoryPullRequests(octokit, repo, cutoff_date, user_stats)

            console.log(`Repo ${repo_name}: ${processed_commits.size} commits found`)
        } catch (repo_error: any) {
            console.log(`Error processing repository ${repo.full_name}: ${repo_error.message}`)
        }
    }

    return user_stats
}

async function processRepositoryBranches(octokit: any, repo: any, since: string, cutoff_date: Date, processed_commits: Set<string>, user_stats: any) {
    const owner_login = repo.owner.login
    const repo_name = repo.name

    const branches = await getBranches(octokit, owner_login, repo_name)
    console.log(`Repository ${repo_name} has ${branches.length} branches`)

    for (const branch of branches) {
        await processBranchCommits(octokit, owner_login, repo_name, branch, since, processed_commits, user_stats)
    }
}

async function getBranches(octokit: any, owner_login: string, repo_name: string) {
    const branches_query = `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        refs(refPrefix: "refs/heads/", first: 100) {
          nodes {
            name
            target {
              oid
            }
          }
        }
      }
    }
  `

    const branches_result = await octokit.graphql(branches_query, {
        owner: owner_login,
        repo: repo_name
    })

    return branches_result.repository.refs.nodes || []
}

async function processBranchCommits(octokit: any, owner_login: string, repo_name: string, branch: any, since: string, processed_commits: Set<string>, user_stats: any) {
    const commits_query = `
    query($owner: String!, $repo: String!, $branchName: String!, $since: GitTimestamp!) {
      repository(owner: $owner, name: $repo) {
        ref(qualifiedName: $branchName) {
          target {
            ... on Commit {
              history(since: $since, first: 100) {
                nodes {
                  oid
                  author {
                    user {
                      login
                      id
                      databaseId
                    }
                    name
                    email
                  }
                  committedDate
                }
              }
            }
          }
        }
      }
    }
  `

    const commits_result = await octokit.graphql(commits_query, {
        owner: owner_login,
        repo: repo_name,
        branchName: `refs/heads/${branch.name}`,
        since: since
    })

    const branch_commits = commits_result.repository.ref?.target?.history?.nodes || []
    console.log(`Branch ${branch.name} has ${branch_commits.length} commits in the period`)

    for (const commit of branch_commits) {
        if (!processed_commits.has(commit.oid)) {
            processed_commits.add(commit.oid)

            const author_login = commit.author.user?.login || commit.author.name || commit.author.email || "Unknown"
            const user_id = commit.author.user?.id || commit.author.user?.databaseId || null

            if (!user_stats[author_login]) {
                user_stats[author_login] = {
                    user_id: user_id,
                    commits_by_repo: {},
                    pull_requests_by_repo: {},
                    total_commits: 0,
                    total_prs_opened: 0,
                    total_prs_closed: 0
                }
            } else if (user_id && !user_stats[author_login].user_id) {
                user_stats[author_login].user_id = user_id
            }

            if (!user_stats[author_login].commits_by_repo[repo_name]) {
                user_stats[author_login].commits_by_repo[repo_name] = 0
            }

            user_stats[author_login].commits_by_repo[repo_name]++
            user_stats[author_login].total_commits++
        }
    }
}

async function processRepositoryPullRequests(octokit: any, repo: any, cutoff_date: Date, user_stats: any) {
    const owner_login = repo.owner.login
    const repo_name = repo.name
    const since_date_str = cutoff_date.toISOString().split('T')[0]

    try {
        const search_query = `repo:${owner_login}/${repo_name} is:pr updated:>=${since_date_str}`
        console.log(`Searching PRs with query: ${search_query}`)

        const search_prs_response = await octokit.request('GET /search/issues', {
            q: search_query,
            per_page: 100,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        })

        console.log(`Search API found ${search_prs_response.data.total_count} PRs for ${repo_name}`)
        await processPullRequestsFromSearch(search_prs_response.data.items, repo, cutoff_date, user_stats)

        if (search_prs_response.data.total_count === 0) {
            console.log(`Using fallback for pulls endpoint for ${repo_name}`)
            await fetchPRsWithPagination(octokit, repo, cutoff_date, user_stats)
        }
    } catch (search_error: any) {
        console.error(`Error searching PRs for ${repo.full_name}: ${search_error.message}`)
        console.log(`Using fallback for pulls endpoint for ${repo_name}`)
        await fetchPRsWithPagination(octokit, repo, cutoff_date, user_stats)
    }
}

async function processPullRequestsFromSearch(search_prs: any[], repo: any, cutoff_date: Date, user_stats: any) {
    const owner_login = repo.owner.login
    const repo_name = repo.name

    for (const pr of search_prs || []) {
        try {
            const pr_repo_regex = /\/repos\/([^\/]+)\/([^\/]+)\/pulls\/\d+/
            const pr_repo_match = pr.pull_request.url.match(pr_repo_regex)

            if (pr_repo_match && pr_repo_match[1] === owner_login && pr_repo_match[2] === repo_name) {
                await processPullRequest(pr, repo_name, cutoff_date, user_stats)
            }
        } catch (pr_error: any) {
            console.log(`Error processing individual PR: ${pr_error.message}`)
        }
    }
}

async function processPullRequest(pr: any, repo_name: string, cutoff_date: Date, user_stats: any) {
    const author_login = pr.user ? pr.user.login : "Unknown"
    const user_id = pr.user?.id || pr.user?.node_id || null

    if (!user_stats[author_login]) {
        user_stats[author_login] = {
            user_id: user_id,
            commits_by_repo: {},
            pull_requests_by_repo: {},
            total_commits: 0,
            total_prs_opened: 0,
            total_prs_closed: 0
        }
    } else if (user_id && !user_stats[author_login].user_id) {
        user_stats[author_login].user_id = user_id
    }

    if (!user_stats[author_login].pull_requests_by_repo[repo_name]) {
        user_stats[author_login].pull_requests_by_repo[repo_name] = {
            opened: 0,
            closed: 0
        }
    }

    const created_at = new Date(pr.created_at)
    if (created_at >= cutoff_date) {
        user_stats[author_login].pull_requests_by_repo[repo_name].opened++
        user_stats[author_login].total_prs_opened++
        console.log(`PR #${pr.number} by ${author_login} counted as opened`)
    }

    if (pr.closed_at) {
        const closed_at = new Date(pr.closed_at)
        if (closed_at >= cutoff_date) {
            user_stats[author_login].pull_requests_by_repo[repo_name].closed++
            user_stats[author_login].total_prs_closed++
            console.log(`PR #${pr.number} by ${author_login} counted as closed`)
        }
    }
}

async function fetchPRsWithPagination(octokit: any, repo: any, cutoff_date: Date, user_stats: any) {
    let page = 1
    let has_more_pages = true
    let total_prs = 0

    while (has_more_pages) {
        try {
            if (page > 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
            }

            console.log(`Fetching PRs for ${repo.name} - page ${page}`)

            const pull_requests_response = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                owner: repo.owner.login,
                repo: repo.name,
                state: 'all',
                sort: 'updated',
                direction: 'desc',
                per_page: 100,
                page: page,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            })

            const pull_requests = pull_requests_response.data
            console.log(`Page ${page}: Found ${pull_requests.length} PRs for ${repo.name}`)

            has_more_pages = pull_requests.length === 100
            page++

            const filtered_prs = pull_requests.filter((pr: { updated_at: string | number | Date }) => {
                try {
                    const updated_at = new Date(pr.updated_at)
                    return updated_at >= cutoff_date
                } catch (err) {
                    console.log(`Error filtering PR: ${err}`)
                    return false
                }
            })

            console.log(`${filtered_prs.length} PRs updated in the specified period`)
            total_prs += filtered_prs.length

            for (const pr of filtered_prs) {
                try {
                    const author_login = pr.user ? pr.user.login : "Unknown"
                    const user_id = pr.user?.id || pr.user?.node_id || null

                    if (!user_stats[author_login]) {
                        user_stats[author_login] = {
                            user_id: user_id,
                            commits_by_repo: {},
                            pull_requests_by_repo: {},
                            total_commits: 0,
                            total_prs_opened: 0,
                            total_prs_closed: 0
                        }
                    } else if (user_id && !user_stats[author_login].user_id) {
                        user_stats[author_login].user_id = user_id
                    }

                    if (!user_stats[author_login].pull_requests_by_repo[repo.name]) {
                        user_stats[author_login].pull_requests_by_repo[repo.name] = {
                            opened: 0,
                            closed: 0
                        }
                    }

                    const created_at = new Date(pr.created_at)
                    if (created_at >= cutoff_date) {
                        user_stats[author_login].pull_requests_by_repo[repo.name].opened++
                        user_stats[author_login].total_prs_opened++
                        console.log(`PR #${pr.number} by ${author_login} counted as opened`)
                    }

                    if (pr.closed_at) {
                        const closed_at = new Date(pr.closed_at)
                        if (closed_at >= cutoff_date) {
                            user_stats[author_login].pull_requests_by_repo[repo.name].closed++
                            user_stats[author_login].total_prs_closed++
                            console.log(`PR #${pr.number} by ${author_login} counted as closed`)
                        }
                    }
                } catch (pr_error: any) {
                    console.log(`Error processing PR: ${pr_error.message}`)
                }
            }

            if (filtered_prs.length === 0 && page > 2) {
                console.log(`No recent PRs found on page ${page - 1}, stopping search`)
                has_more_pages = false
            }
        } catch (error: any) {
            console.error(`Error fetching PRs (page ${page}): ${error.message}`)
            if (error.status === 403 && error.message.includes('rate limit')) {
                console.log('Rate limit reached, waiting 60 seconds...')
                await new Promise(resolve => setTimeout(resolve, 60000))
                page--
            } else {
                has_more_pages = false
            }
        }
    }

    console.log(`Total of ${total_prs} recent PRs found for ${repo.name}`)
    return total_prs
}

function formatInstallationStats(installation: any, days_to_look_back: number, user_stats: any) {
    const installation_stats: InstallationStats = {
        id: installation.id,
        account: installation.account.login,
        account_type: installation.account.type,
        period_days: days_to_look_back,
        user_stats: []
    }

    for (const [user_name, stats] of Object.entries(user_stats)) {
        const user_stat: UserStat = {
            name: user_name,
            user_id: (stats as any).user_id,
            total_commits: (stats as any).total_commits,
            total_prs_opened: (stats as any).total_prs_opened,
            total_prs_closed: (stats as any).total_prs_closed,
            repo_contributions: []
        }

        const repo_set = new Set([
            ...Object.keys((stats as any).commits_by_repo),
            ...Object.keys((stats as any).pull_requests_by_repo)
        ])

        for (const repo_name of repo_set) {
            const repo_stat: RepoContribution = {
                repo_name: repo_name,
                commits: (stats as any).commits_by_repo[repo_name] || 0,
                prs_opened: ((stats as any).pull_requests_by_repo[repo_name] && (stats as any).pull_requests_by_repo[repo_name].opened) || 0,
                prs_closed: ((stats as any).pull_requests_by_repo[repo_name] && (stats as any).pull_requests_by_repo[repo_name].closed) || 0
            }

            user_stat.repo_contributions.push(repo_stat)
        }

        installation_stats.user_stats.push(user_stat)
    }

    return installation_stats
}

function generateReport(results: (InstallationStats | InstallationError)[]) {
    let report_lines = []

    for (const installation of results) {
        if ('error' in installation) {
            report_lines.push(`⚠️ Installation ${installation.account}: ${installation.error}`)
            continue
        }

        const period_label = installation.period_days === 7 ? "week" :
            (installation.period_days === 30 ? "month" :
                `${installation.period_days} days`)

        report_lines.push(`📊 Statistics for ${installation.account} (${installation.account_type}) - Last ${period_label}:`)

        if (installation.user_stats && installation.user_stats.length > 0) {
            installation.user_stats.sort((a, b) => {
                const total_a = a.total_commits + a.total_prs_opened + a.total_prs_closed
                const total_b = b.total_commits + b.total_prs_opened + b.total_prs_closed
                return total_b - total_a
            })

            for (const user of installation.user_stats) {
                const user_id_info = user.user_id ? ` (ID: ${user.user_id})` : ''
                report_lines.push(`\n👤 ${user.name}${user_id_info}:`)
                report_lines.push(`  Total: ${user.total_commits} commits, ${user.total_prs_opened} PRs opened, ${user.total_prs_closed} PRs closed`)

                user.repo_contributions.sort((a, b) => {
                    const total_a = a.commits + a.prs_opened + a.prs_closed
                    const total_b = b.commits + b.prs_opened + b.prs_closed
                    return total_b - total_a
                })

                report_lines.push(`  Contributions by repository:`)
                for (const repo of user.repo_contributions) {
                    report_lines.push(`    - ${repo.repo_name}: ${repo.commits} commits, ${repo.prs_opened} PRs opened, ${repo.prs_closed} PRs closed`)
                }
            }
        } else {
            report_lines.push(`  No contributions found in the period.`)
        }

        report_lines.push('')
    }

    return report_lines.join('\n')
}