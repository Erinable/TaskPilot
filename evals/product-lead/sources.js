// File contents for the eval fixture repositories, so Architect has real code
// to read. Only files a case is likely to touch have contents; the rest of
// each file list exists as paths only, and the eval writes empty stubs.
//
// The code is deliberately specific (async-only repository, a NotFoundError
// convention, a non-default test helper) so a plan that ignores it is
// detectably wrong.

const TS_API = {
  'package.json': JSON.stringify({
    name: 'api', type: 'module',
    scripts: { test: 'vitest run' },
    dependencies: { bcrypt: '5.1.1', jsonwebtoken: '9.0.2', pg: '8.11.3' },
    devDependencies: { vitest: '1.6.0', typescript: '5.4.5' },
  }, null, 2),
  'src/auth/user.ts': `export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}
`,
  'src/auth/user-repository.ts': `import type { Db } from '../db/client';
import type { User } from './user';

export class NotFoundError extends Error {}

const COLUMNS = 'id, email, password_hash AS "passwordHash", created_at AS "createdAt"';

export class UserRepository {
  constructor(private readonly db: Db) {}

  /** Throws NotFoundError when the user does not exist. */
  async getById(id: string): Promise<User> {
    const rows = await this.db.query<User>(\`SELECT \${COLUMNS} FROM users WHERE id = $1\`, [id]);
    if (rows.length === 0) throw new NotFoundError(\`user \${id}\`);
    return rows[0];
  }

  async create(email: string, passwordHash: string): Promise<User> {
    const rows = await this.db.query<User>(
      \`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING \${COLUMNS}\`,
      [email, passwordHash],
    );
    return rows[0];
  }
}
`,
  'src/auth/token-service.ts': `import jwt from 'jsonwebtoken';

export interface TokenClaims { sub: string }

export class TokenService {
  constructor(private readonly secret: string, private readonly ttlSeconds = 3600) {}

  issue(userId: string): string {
    return jwt.sign({ sub: userId } satisfies TokenClaims, this.secret, { expiresIn: this.ttlSeconds });
  }

  verify(token: string): TokenClaims {
    return jwt.verify(token, this.secret) as TokenClaims;
  }
}
`,
  'src/db/client.ts': `import pg from 'pg';

export interface Db {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  return { query: async (sql, params) => (await pool.query(sql, params)).rows };
}
`,
  'src/db/migrations/001_users.sql': `CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  'src/http/router.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, body: unknown) => Promise<{ status: number; json: unknown }>;

const routes = new Map<string, Handler>();

export function route(method: string, path: string, handler: Handler): void {
  routes.set(\`\${method} \${path}\`, handler);
}

export function lookup(method: string, path: string): Handler | undefined {
  return routes.get(\`\${method} \${path}\`);
}
`,
  'src/http/middleware/error-handler.ts': `import { NotFoundError } from '../../auth/user-repository';

export function toHttpError(error: unknown): { status: number; json: unknown } {
  if (error instanceof NotFoundError) return { status: 404, json: { error: 'not_found' } };
  return { status: 500, json: { error: 'internal' } };
}
`,
  'tests/helpers/fake-db.ts': `import type { Db } from '../../src/db/client';

/** An in-memory Db that returns the given rows for any query. */
export function fakeDb(rows: unknown[]): Db {
  return { query: async () => rows as never[] };
}
`,
  'tests/auth/user-repository.test.ts': `import { describe, expect, it } from 'vitest';
import { UserRepository, NotFoundError } from '../../src/auth/user-repository';
import { fakeDb } from '../helpers/fake-db';

describe('UserRepository.getById', () => {
  it('returns the user', async () => {
    const db = fakeDb([{ id: 'u1', email: 'a@example.com' }]);
    expect((await new UserRepository(db).getById('u1')).email).toBe('a@example.com');
  });

  it('throws NotFoundError for an unknown id', async () => {
    await expect(new UserRepository(fakeDb([])).getById('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
`,
};

const REACT_APP = {
  'package.json': JSON.stringify({
    name: 'web', type: 'module',
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1', 'react-router-dom': '6.23.1', '@tanstack/react-query': '5.40.0' },
    devDependencies: { vitest: '1.6.0', '@testing-library/react': '15.0.7', vite: '5.2.12' },
  }, null, 2),
  'src/App.tsx': `import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { OrdersPage } from './pages/OrdersPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<OrdersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
`,
  'src/api/client.ts': `export async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(\`/api\${path}\`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), credentials: 'include' });
  if (!res.ok) throw new Error(\`\${method} \${path} failed: \${res.status}\`);
  return res.status === 204 ? (undefined as T) : res.json();
}
`,
  'src/api/orders.ts': `import { request } from './client';

export interface Order { id: string; customer: string; total: number; createdAt: string }

/** Returns every order; the API has no pagination yet. */
export const listOrders = () => request<Order[]>('GET', '/orders');
`,
  'src/hooks/useOrders.ts': `import { useQuery } from '@tanstack/react-query';
import { listOrders } from '../api/orders';

export const useOrders = () => useQuery({ queryKey: ['orders'], queryFn: listOrders });
`,
  'src/components/Table.tsx': `export interface Column<T> { key: keyof T; title: string }

export function Table<T extends { id: string }>({ rows, columns }: { rows: T[]; columns: Column<T>[] }) {
  return (
    <table>
      <thead><tr>{columns.map((c) => <th key={String(c.key)}>{c.title}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>{columns.map((c) => <td key={String(c.key)}>{String(row[c.key])}</td>)}</tr>)}</tbody>
    </table>
  );
}
`,
  'src/components/Modal.tsx': `export function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: React.ReactNode; onClose: () => void }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      {children}
      <button onClick={onClose}>Close</button>
    </div>
  );
}
`,
  'src/components/Button.tsx': `export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' }) {
  return <button className={\`btn btn-\${variant}\`} {...props} />;
}
`,
  'src/pages/OrdersPage.tsx': `import { Table } from '../components/Table';
import { useOrders } from '../hooks/useOrders';

export function OrdersPage() {
  const { data = [], isLoading } = useOrders();
  if (isLoading) return <p>Loading…</p>;
  return <Table rows={data} columns={[{ key: 'customer', title: 'Customer' }, { key: 'total', title: 'Total' }, { key: 'createdAt', title: 'Date' }]} />;
}
`,
  'src/pages/SettingsPage.tsx': `import { Button } from '../components/Button';

export function SettingsPage() {
  return (
    <section>
      <h1>Settings</h1>
      <Button variant="primary">Save</Button>
    </section>
  );
}
`,
  'src/pages/__tests__/OrdersPage.test.tsx': `import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrdersPage } from '../OrdersPage';

vi.mock('../../hooks/useOrders', () => ({ useOrders: () => ({ data: [{ id: '1', customer: 'Ada', total: 10, createdAt: '2026-01-01' }], isLoading: false }) }));

describe('OrdersPage', () => {
  it('renders orders', () => {
    render(<OrdersPage />);
    expect(screen.getByText('Ada')).toBeTruthy();
  });
});
`,
};

const PY_SERVICE = {
  'pyproject.toml': `[project]
name = "billing"
dependencies = ["fastapi==0.111.0", "sqlalchemy==2.0.30"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
  'app/main.py': `from fastapi import FastAPI

from app.billing.invoices import router as invoices_router

app = FastAPI()
app.include_router(invoices_router, prefix="/invoices")
`,
  'app/billing/models.py': `from sqlalchemy import Boolean, ForeignKey, Numeric, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255))


class Invoice(Base):
    __tablename__ = "invoices"
    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    total: Mapped[float] = mapped_column(Numeric(10, 2))
    issued: Mapped[bool] = mapped_column(Boolean, default=False)
`,
  'app/billing/invoices.py': `from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.billing.models import Invoice
from app.config import get_session

router = APIRouter()


def issue_invoice(session: Session, invoice_id: int) -> Invoice:
    invoice = session.get(Invoice, invoice_id)
    invoice.issued = True
    session.commit()
    return invoice


@router.post("/{invoice_id}/issue")
def issue(invoice_id: int, session: Session = Depends(get_session)):
    return {"id": issue_invoice(session, invoice_id).id}
`,
  'app/notifications/email.py': `import smtplib
from email.message import EmailMessage

from app.config import settings


def send_email(to: str, subject: str, body: str) -> None:
    """Sends a plain-text email. Raises smtplib.SMTPException on failure."""
    message = EmailMessage()
    message["To"], message["From"], message["Subject"] = to, settings.mail_from, subject
    message.set_content(body)
    with smtplib.SMTP(settings.smtp_host) as smtp:
        smtp.send_message(message)
`,
  'app/config.py': `from functools import lru_cache

from pydantic_settings import BaseSettings
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


class Settings(BaseSettings):
    database_url: str = "sqlite:///billing.db"
    smtp_host: str = "localhost"
    mail_from: str = "billing@example.com"


settings = Settings()
SessionLocal = sessionmaker(bind=create_engine(settings.database_url))


def get_session():
    with SessionLocal() as session:
        yield session
`,
  'tests/conftest.py': `import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.billing.models import Base


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
`,
  'tests/test_invoices.py': `from app.billing.invoices import issue_invoice
from app.billing.models import Customer, Invoice


def test_issue_invoice_marks_issued(session):
    session.add_all([Customer(id=1, email="a@example.com"), Invoice(id=1, customer_id=1, total=10)])
    session.commit()
    assert issue_invoice(session, 1).issued is True
`,
};

module.exports = { TS_API, REACT_APP, PY_SERVICE };
