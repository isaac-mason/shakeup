// Real-world-shaped React component module (plain JS + JSX, no TS).
// Covers: capitalized component heads, intrinsic tags, fragments, nesting,
// spreads, keys, expressions-in-children, conditional/list rendering, attributes.
import React from 'react';
import { Card, Icon } from './ui';

function Avatar({ user, size = 40, ...rest }) {
    return (
        <img
            className="avatar"
            src={user.avatarUrl}
            width={size}
            height={size}
            alt={`avatar for ${user.name}`}
            {...rest}
        />
    );
}

export function UserList({ users, onSelect }) {
    return (
        <ul className="user-list" data-count={users.length}>
            {users.map((user) => (
                <li key={user.id} className={user.active ? 'active' : 'inactive'}>
                    <Avatar user={user} size={32} />
                    <span>{user.name}</span>
                    {user.admin && <Icon name="star" />}
                    {user.badges.length > 0 ? (
                        <ul>
                            {user.badges.map((b, i) => (
                                <li key={i}>{b.label}</li>
                            ))}
                        </ul>
                    ) : null}
                    <button onClick={() => onSelect(user)}>Select</button>
                </li>
            ))}
        </ul>
    );
}

export default function App({ users }) {
    return (
        <>
            <header>
                <h1>Users ({users.length})</h1>
            </header>
            <Card>
                <UserList users={users} onSelect={(u) => console.log(u)} />
            </Card>
            <footer>&copy; 2026 &amp; friends</footer>
        </>
    );
}
