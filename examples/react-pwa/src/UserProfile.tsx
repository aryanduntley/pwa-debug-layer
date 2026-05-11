export type UserProfileProps = {
  readonly name: string;
  readonly role: string;
};

export const UserProfile = ({ name, role }: UserProfileProps): JSX.Element => (
  <section role="region" aria-label="user profile">
    <h2>user-profile-marker</h2>
    <p>name: {name}</p>
    <p>role: {role}</p>
  </section>
);

UserProfile.displayName = 'UserProfile';
