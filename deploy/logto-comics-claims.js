// Installed through Logto Console > Custom JWT > User access token.
// Other API audiences keep their original claims.
const getCustomJwtClaims = async ({ token, context }) => {
  const audiences = Array.isArray(token.aud) ? token.aud : [token.aud];
  if (!audiences.includes('https://comics.nodelane.net/api')) return {};
  const assignedRoles = context?.user?.roles ?? [];
  return {
    roles: assignedRoles
      .filter((role) => role.name === 'node-comics-admin')
      .map((role) => role.name),
  };
};
