'use strict'

// C12 fixture：故意缺 hub 角色，check-roles 应 exit 1。
const real = require('../../lib/roles.cjs')
const ROLES = real.ROLES.filter((role) => role.id !== 'hub').map((role) => ({ ...role }))
const ROLE_IDS = ROLES.map((role) => role.id)

function getRole(id) {
  return ROLES.find((role) => role.id === id) || null
}

module.exports = { ROLES, ROLE_IDS, getRole, VERSION: real.VERSION }
