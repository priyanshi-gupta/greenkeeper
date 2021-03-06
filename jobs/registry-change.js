const _ = require('lodash')
const semver = require('semver')
const Log = require('gk-log')

const dbs = require('../lib/dbs')
const updatedAt = require('../lib/updated-at')
const statsd = require('../lib/statsd')
const getConfig = require('../lib/get-config')
const {
  seperateNormalAndMonorepos,
  getJobsPerGroup,
  filterAndSortPackages,
  getSatisfyingVersions,
  getOldVersionResolved
} = require('../utils/utils')
const {
  isPartOfMonorepo,
  hasAllMonorepoUdates,
  getMonorepoGroup,
  updateMonorepoReleaseInfo,
  deleteMonorepoReleaseInfo,
  getMonorepoGroupNameForPackage
} = require('../lib/monorepo')

module.exports = async function (
  { dependency, distTags, versions, installation, force }
) {
  const { installations, repositories, npm } = await dbs()
  const logs = dbs.getLogsDb()
  const log = Log({logsDb: logs, accountId: null, repoSlug: null, context: 'registry-change'})
  log.info(`started registry-change for dependency ${dependency}`, {dependency, versions})

  const isFromHook = _.isString(installation)
  let npmDoc = {
    _id: dependency,
    distTags,
    versions
  }

  // use prefix for packageFilesForUpdatedDependency sent via webhook
  if (isFromHook) npmDoc._id = `${installation}:${npmDoc._id}`

  try {
    var npmDbDoc = await npm.get(npmDoc._id)
  } catch (err) {
    if (err.status !== 404) throw err
    log.warn(`Warning: failed to load npmDoc for ${dependency} (Is probably new).`)
    npmDbDoc = {}
  }

  const oldDistTags = npmDbDoc.distTags || {}
  const distTag = _.findKey(distTags, (version, tag) => {
    const oldVersion = oldDistTags[tag]
    if (!oldVersion) {
      log.info(`exited: nothing to update, is first release of ${dependency}`)
      return true
    }
    return semver.lt(oldVersion, version)
  })

  if (!distTag) {
    log.info(`exited: ${dependency} has no distTag`)
    return
  }
  await npm.put(updatedAt(Object.assign(npmDbDoc, npmDoc)))

  // currently we only handle latest versions
  // so we can heavily optimise by exiting here
  // we want to handle different distTags in the future
  if (distTag !== 'latest') {
    log.info(`exited: ${dependency} distTag is ${distTag} (not latest)`)
    return
  }

  const version = distTags['latest']
  // Ignore releases on `latest` that have prerelease identifiers
  if (semver.prerelease(version)) {
    log.info(`exited: ${dependency} ${version} is a prerelease on latest`)
    return
  }

  let dependencies = [ dependency ]

  // check if dependency update is part of a monorepo release
  if (await isPartOfMonorepo(dependency)) {
    // We only want to open a PR if either:
    // 1. We have all of the modules that belong to the release (have the same version number)
    // 2. The release is forced by the monorepo-supervisor. This means the release is still incomplete
    //    after n minutes, but we want to open the PR anyway
    if (!await hasAllMonorepoUdates(dependency, version) && !force) {
      log.info('exited: is not last in list of monorepo packages')
      // create/update npm/monorepo:dependency-version
      await updateMonorepoReleaseInfo(dependency, distTags, distTag, versions)
      return // do nothing, one of the next registry-change jobs is going to handle the rest
    }
    // do the update now
    await deleteMonorepoReleaseInfo(dependency, version)

    // set up keys so we can query for all packages with a dependency on any of the packages
    // in our monorepo group
    dependencies = await getMonorepoGroup(await getMonorepoGroupNameForPackage(dependency)) || dependencies
  }

  /*
  Update: 'by_dependency' handles multiple package.json files, but not in the same result.

  You get one result per matching dependency per depencyType per file in `packageFilesForUpdatedDependency`. The `value`
  object for each result (used below, in `filteredSortedPackages` for example), looks like:

  "value": {
    "fullName": "aveferrum/angular-material-demo",
    "accountId": "462667",
    "filename": "frontend/package.json", // <- yay, works
    "type": "dependencies",
    "oldVersion": "^4.2.4"
  }

  Then in a separate result, you’d get

  "value": {
    "fullName": "aveferrum/angular-material-demo",
    "accountId": "462667",
    "filename": "backend/package.json",
    "type": "dependencies",
    "oldVersion": "^4.2.4"
  }
  */

  // packageFilesForUpdatedDependency are a list of all repoDocs that have that dependency (should rename that)
  const packageFilesForUpdatedDependency = (await repositories.query('by_dependency', {
    keys: dependencies
  })).rows

  if (!packageFilesForUpdatedDependency.length) {
    log.info(`exited: no repoDocs found that depend on ${dependency}`)
    return
  }
  log.info(`found ${packageFilesForUpdatedDependency.length} repoDocs that use ${dependency}`)

  if (packageFilesForUpdatedDependency.length > 100) statsd.event('popular_package')

  // check if package has a greenkeeper.json / more then 1 package json or package.json is in subdirectory
  // continue with the rest but send all otheres to a 'new' version branch job

  let jobs = []
  const seperatedResults = seperateNormalAndMonorepos(packageFilesForUpdatedDependency)

  const withOnlyRootPackageJSON = _.flatten(seperatedResults[1])
  const withMultiplePackageJSON = seperatedResults[0]

  const accounts = _.keyBy(
    _.map(
      (await installations.allDocs({
        keys: _.compact(_.map(_.flattenDeep(seperatedResults), 'value.accountId')),
        include_docs: true
      })).rows,
      'doc'
    ),
    '_id'
  )

  // ******** Monorepos begin
  // get config
  const keysToFindMonorepoDocs = _.compact(_.map(withMultiplePackageJSON, (group) => group[0].value.fullName))
  if (keysToFindMonorepoDocs.length) {
    const monorepoDocs = (await repositories.query('by_full_name', {
      keys: keysToFindMonorepoDocs,
      include_docs: true
    })).rows

    _.forEach(withMultiplePackageJSON, monorepo => {
      const account = accounts[monorepo[0].value.accountId]
      const plan = account.plan
      const repoDoc = monorepoDocs.find(doc => doc.key === monorepo[0].value.fullName)
      if (!repoDoc) return
      const config = getConfig(repoDoc.doc)
      jobs = jobs.concat(getJobsPerGroup({
        config,
        monorepo,
        distTags,
        distTag,
        dependency,
        versions,
        account,
        repositoryId: repoDoc.id,
        plan}))
    })
  }
  // ******** Monorepos end

  // Prioritize `dependencies` over all other dependency types
  // https://github.com/greenkeeperio/greenkeeper/issues/409

  const filteredSortedPackages = filterAndSortPackages(withOnlyRootPackageJSON)

  jobs = [...jobs, ...(_.sortedUniqBy(filteredSortedPackages, pkg => pkg.value.fullName)
    .map(pkg => {
      const account = accounts[pkg.value.accountId]
      const plan = account.plan

      const satisfyingVersions = getSatisfyingVersions(versions, pkg)
      const oldVersionResolved = getOldVersionResolved(satisfyingVersions, distTags, distTag)

      if (isFromHook && String(account.installation) !== installation) return {}

      return {
        data: Object.assign(
          {
            name: 'create-version-branch',
            dependency,
            distTags,
            distTag,
            versions,
            oldVersionResolved,
            repositoryId: pkg.id,
            installation: account.installation,
            plan
          },
          pkg.value
        ),
        plan
      }
    }))
  ]
  log.success(`${jobs.length} registry-change jobs for dependency ${dependency} created`)
  return jobs
}
