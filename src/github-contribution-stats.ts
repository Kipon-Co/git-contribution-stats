import { App } from "octokit"
import { Logger } from "./logger"

export interface GitHubActivityConfig {
    app_id: number
    private_key: string
    days_to_look_back?: number
    logger?: Logger
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
    instalation_id: number
    account: string
    account_type: string
    period_days: number
    user_id: number
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
    const logger = config.logger || new Logger({
        level: 'info',
        scope: ['GitHubReport']
    })

    logger.start(`Initializing GitHub App with ID: ${app_id}`)
    const app = await initializeGitHubApp(app_id, private_key)
    
    try {
        const installations = await getInstallations(app)
        logger.info(`Found ${installations.length} installations`)

        const results = await processInstallations(app, installations, days_to_look_back, logger)
        logger.info(`Generating report for ${results.length} installations`)
        const report = generateReport(results)

        logger.success(`GitHub activity report generated successfully`)
        return {
            summary: report,
            detailed_results: results
        }
    } catch (error: any) {
        logger.error(`Error accessing GitHub API: ${error.message}`)
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

async function processInstallations(app: any, installations: any[], days_to_look_back: number, logger: Logger) {
    const results = []

    logger.start(`Processing ${installations.length} installations`)
    
    for (const [index, installation] of installations.entries()) {
        logger.pending(`Processing installation ${index+1}/${installations.length}`)
        
        try {
            const octokit = await app.getInstallationOctokit(installation.id)
            const repos = await getRepositories(octokit)
            logger.info(`Has access to ${repos.length} repositories`)

            const cutoff_date = calculateCutoffDate(days_to_look_back)
            const updated_repos = filterUpdatedRepositories(repos, cutoff_date, logger)
            logger.info(`${updated_repos.length} of ${repos.length} repositories were updated in the last ${days_to_look_back} days`)

            if (updated_repos.length > 0) {
                logger.start(`Processing repositories for ${installation.account.login}`)
            }

            const user_stats = await collectUserStats(octokit, updated_repos, cutoff_date, logger)
            const installation_stats = formatInstallationStats(installation, days_to_look_back, user_stats)
            
            logger.complete(`Finished processing for ${installation.account.login}`)
            results.push(installation_stats)
        } catch (error: any) {
            logger.error(`Error processing installation: ${error.message}`)
            results.push({
                id: installation.id,
                account: installation.account.login,
                error: error.message
            })
        }
    }

    logger.complete(`Processed all ${installations.length} installations`)
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

function filterUpdatedRepositories(repos: any[], cutoff_date: Date, logger: Logger) {
    
    logger.start(`Filtering ${repos.length} repositories by update date`)
    
    const filtered = repos.filter(repo => {
        const last_pushed = new Date(repo.pushed_at || 0)
        const last_updated = new Date(repo.updated_at || 0)
        const latest_activity = last_pushed > last_updated ? last_pushed : last_updated

        const was_updated_in_period = latest_activity >= cutoff_date
        if (!was_updated_in_period) {
            logger.debug(`Skipping repository ${repo.full_name} - no updates since ${cutoff_date.toISOString()}`)
        }
        return was_updated_in_period
    })
    
    logger.complete(`Filtered repositories: ${filtered.length} matched criteria`)
    return filtered
}

async function collectUserStats(octokit: any, updated_repos: any[], cutoff_date: Date, logger: Logger) {
    const user_stats: any = {}
    const since = cutoff_date.toISOString()

    logger.start(`Collecting stats for ${updated_repos.length} repositories`)

    for (const [index, repo] of updated_repos.entries()) {
        try {
            const processed_commits = new Set<string>()
            
            logger.pending(`Processing repository ${index+1}/${updated_repos.length}: ${repo.full_name}`)
            
            await processRepositoryBranches(octokit, repo, since, cutoff_date, processed_commits, user_stats, logger)
            await processRepositoryPullRequests(octokit, repo, cutoff_date, user_stats, logger)

            logger.complete(`Found ${processed_commits.size} commits in ${repo.name}`)
        } catch (repo_error: any) {
            logger.error(`Error processing repository: ${repo_error.message}`)
        }
    }

    logger.complete(`Collected stats for all repositories`)
    return user_stats
}

async function processRepositoryBranches(octokit: any, repo: any, since: string, cutoff_date: Date, processed_commits: Set<string>, user_stats: any, logger: Logger) {
    const owner_login = repo.owner.login
    const repo_name = repo.name

    const branches = await getBranches(octokit, owner_login, repo_name)
    logger.info(`Repository has ${branches.length} branches`)

    for (const branch of branches) {
        await processBranchCommits(octokit, owner_login, repo_name, branch, since, processed_commits, user_stats,logger)
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

async function processBranchCommits(octokit: any, owner_login: string, repo_name: string, branch: any, since: string, processed_commits: Set<string>, user_stats: any, logger: Logger) {
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
    logger.debug(`Found ${branch_commits.length} commits in the period`)

    for (const commit of branch_commits) {
        if (!processed_commits.has(commit.oid)) {
            processed_commits.add(commit.oid)

            const author_login = commit.author.user?.login || commit.author.name || commit.author.email || "Unknown"
            const user_id = commit.author.user?.databaseId || null

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

async function processRepositoryPullRequests(octokit: any, repo: any, cutoff_date: Date, user_stats: any, logger: Logger) {
    const owner_login = repo.owner.login
    const repo_name = repo.name
    const since_date_str = cutoff_date.toISOString().split('T')[0]

    try {
        const search_query = `repo:${owner_login}/${repo_name} is:pr updated:>=${since_date_str}`
        logger.debug(`Searching PRs with query: ${search_query}`)

        const search_prs_response = await octokit.request('GET /search/issues', {
            q: search_query,
            per_page: 100,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        })

        logger.info(`Search API found ${search_prs_response.data.total_count} PRs for ${repo_name}`)
        await processPullRequestsFromSearch(search_prs_response.data.items, repo, cutoff_date, user_stats, logger)

        if (search_prs_response.data.total_count === 0) {
            logger.note(`Using fallback for pulls endpoint for ${repo_name}`)
            await fetchPRsWithPagination(octokit, repo, cutoff_date, user_stats, logger)
        }
    } catch (search_error: any) {
        logger.error(`Error searching PRs for ${repo.full_name}: ${search_error.message}`)
        logger.note(`Using fallback for pulls endpoint for ${repo_name}`)
        await fetchPRsWithPagination(octokit, repo, cutoff_date, user_stats, logger)
    }
}

async function processPullRequestsFromSearch(search_prs: any[], repo: any, cutoff_date: Date, user_stats: any, logger: Logger) {
    const owner_login = repo.owner.login
    const repo_name = repo.name

    for (const pr of search_prs || []) {
        try {
            const pr_repo_regex = /\/repos\/([^\/]+)\/([^\/]+)\/pulls\/\d+/
            const pr_repo_match = pr.pull_request.url.match(pr_repo_regex)

            if (pr_repo_match && pr_repo_match[1] === owner_login && pr_repo_match[2] === repo_name) {
                await processPullRequest(pr, repo_name, cutoff_date, user_stats, logger)
            }
        } catch (pr_error: any) {
            logger.error(`Error processing individual PR: ${pr_error.message}`)
        }
    }
}

async function processPullRequest(pr: any, repo_name: string, cutoff_date: Date, user_stats: any, logger: Logger) {
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
        logger.debug(`PR #${pr.number} by ${author_login} counted as opened`)
    }

    if (pr.closed_at) {
        const closed_at = new Date(pr.closed_at)
        if (closed_at >= cutoff_date) {
            user_stats[author_login].pull_requests_by_repo[repo_name].closed++
            user_stats[author_login].total_prs_closed++
            logger.debug(`PR #${pr.number} by ${author_login} counted as closed`)
        }
    }
}

async function fetchPRsWithPagination(octokit: any, repo: any, cutoff_date: Date, user_stats: any, logger: Logger) {
    let page = 1
    let has_more_pages = true
    let total_prs = 0

    while (has_more_pages) {
        try {
            if (page > 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
            }

            logger.pending(`Fetching PRs for ${repo.name} - page ${page}`)

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
            logger.info(`Page ${page}: Found ${pull_requests.length} PRs for ${repo.name}`)

            has_more_pages = pull_requests.length === 100
            page++

            const filtered_prs = pull_requests.filter((pr: { updated_at: string | number | Date }) => {
                try {
                    const updated_at = new Date(pr.updated_at)
                    return updated_at >= cutoff_date
                } catch (err) {
                    logger.error(`Error filtering PR: ${err}`)
                    return false
                }
            })

            logger.info(`${filtered_prs.length} PRs updated in the specified period`)
            total_prs += filtered_prs.length

            for (const pr of filtered_prs) {
                try {
                    await processPullRequest(pr, repo.name, cutoff_date, user_stats, logger)
                } catch (pr_error: any) {
                    logger.error(`Error processing PR: ${pr_error.message}`)
                }
            }

            if (filtered_prs.length === 0 && page > 2) {
                logger.note(`No recent PRs found on page ${page - 1}, stopping search`)
                has_more_pages = false
            }
        } catch (error: any) {
            logger.error(`Error fetching PRs (page ${page}): ${error.message}`)
            if (error.status === 403 && error.message.includes('rate limit')) {
                logger.warn('Rate limit reached, waiting 60 seconds...')
                await new Promise(resolve => setTimeout(resolve, 60000))
                page--
            } else {
                has_more_pages = false
            }
        }
    }

    logger.complete(`Total of ${total_prs} recent PRs found for ${repo.name}`)
    return total_prs
}

function formatInstallationStats(installation: any, days_to_look_back: number, user_stats: any) {
    const installation_stats: InstallationStats = {
        instalation_id: installation.id,
        account: installation.account.login,
        user_id: installation.account.id,
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