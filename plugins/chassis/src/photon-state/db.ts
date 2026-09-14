export interface PhotonStateQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface PhotonStateTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PhotonStateQueryResult<Row>>;
}

export interface PhotonStateDatabase extends PhotonStateTransaction {
  transaction<T>(work: (transaction: PhotonStateTransaction) => Promise<T>): Promise<T>;
}
