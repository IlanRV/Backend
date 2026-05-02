import * as admin from 'firebase-admin';
import { config } from '../config';
import { createLogger } from './logger';

let firestore: FirebaseFirestore.Firestore | null = null;
const logger = createLogger('firebase');

const idFieldsByCollection: Record<string, string> = {
  workspaces: 'workspaceId',
  repos: 'repoId',
  repo_files: 'repoFileId',
  chat_messages: 'messageId',
};

function getIdField(collection: string): string {
  return idFieldsByCollection[collection] || `${collection.slice(0, -1)}Id`;
}

function withDocumentId<T extends FirebaseFirestore.DocumentData>(
  collection: string,
  id: string,
  data: T
): T & { id: string } {
  const idField = getIdField(collection);
  return {
    ...data,
    id,
    [idField]: data[idField] || id,
  };
}

function createFirestore(): FirebaseFirestore.Firestore {
  const { projectId, privateKey, clientEmail } = config.firebase;

  if (!projectId || !privateKey || !clientEmail) {
    logger.error('firebase_credentials_missing', {
      hasProjectId: Boolean(projectId),
      hasPrivateKey: Boolean(privateKey),
      hasClientEmail: Boolean(clientEmail),
    });
    throw new Error(
      'Firebase credentials are not configured. Set FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, and FIREBASE_CLIENT_EMAIL in server/.env.'
    );
  }

  if (!admin.apps.length) {
    logger.info('firebase_admin_initializing', { projectId });
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        privateKey,
        clientEmail,
      }),
    });
  }

  logger.info('firestore_ready', { projectId });
  return admin.firestore();
}

export function getDb(): FirebaseFirestore.Firestore {
  if (!firestore) {
    firestore = createFirestore();
  }

  return firestore;
}

export const db = new Proxy({} as FirebaseFirestore.Firestore, {
  get(_target, property) {
    const firestoreDb = getDb();
    const value = firestoreDb[property as keyof FirebaseFirestore.Firestore];
    return typeof value === 'function' ? value.bind(firestoreDb) : value;
  },
});

export function getCollection(name: string): FirebaseFirestore.CollectionReference {
  return getDb().collection(name);
}

export async function getDoc<T extends FirebaseFirestore.DocumentData>(
  collection: string,
  id: string
): Promise<(T & { id: string }) | null> {
  const document = await getDb().collection(collection).doc(id).get();

  if (!document.exists) {
    return null;
  }

  return withDocumentId(collection, document.id, document.data() as T);
}

export async function setDoc(
  collection: string,
  id: string,
  data: FirebaseFirestore.DocumentData,
  options?: FirebaseFirestore.SetOptions
): Promise<void> {
  const reference = getDb().collection(collection).doc(id);

  if (options) {
    await reference.set(data, options);
    return;
  }

  await reference.set(data);
}

export async function queryDocs<T extends FirebaseFirestore.DocumentData>(
  collection: string,
  field: string,
  operator: FirebaseFirestore.WhereFilterOp,
  value: unknown
): Promise<Array<T & { id: string }>> {
  const snapshot = await getDb().collection(collection).where(field, operator, value).get();
  return snapshot.docs.map((document) => withDocumentId(collection, document.id, document.data() as T));
}

export async function deleteDoc(collection: string, id: string): Promise<void> {
  await getDb().collection(collection).doc(id).delete();
}

export async function deleteQuerySnapshot(
  snapshot: FirebaseFirestore.QuerySnapshot
): Promise<number> {
  let batch = getDb().batch();
  let operationCount = 0;
  let deletedCount = 0;

  for (const document of snapshot.docs) {
    batch.delete(document.ref);
    operationCount += 1;
    deletedCount += 1;

    if (operationCount === 450) {
      await batch.commit();
      batch = getDb().batch();
      operationCount = 0;
    }
  }

  if (operationCount > 0) {
    await batch.commit();
  }

  return deletedCount;
}

export async function deleteDocsByQuery(query: FirebaseFirestore.Query): Promise<number> {
  const snapshot = await query.get();
  const deletedCount = await deleteQuerySnapshot(snapshot);
  return deletedCount;
}
