import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

const DEFAULT_EKS_TOKEN_TTL_SECONDS = 14 * 60;

type EksClusterInfo = {
  endpoint: string;
  certificateAuthorityData?: string;
};

type EksTokenResult = {
  token: string;
  expiresAtMs: number;
};

type EksAuthOptions = {
  clusterName: string;
  region: string;
  profile?: string;
  roleArn?: string;
  credentials?: unknown;
  expiresInSeconds?: number;
  now?: Date;
};

const loadEksSdk = (): {
  EKSClient: new (config: { region: string; credentials?: unknown }) => {
    send: (command: unknown) => Promise<{ cluster?: { endpoint?: string; certificateAuthority?: { data?: string } } }>;
  };
  DescribeClusterCommand: new (input: { name: string }) => unknown;
} => {
  try {
    return requireModule("@aws-sdk/client-eks");
  } catch {
    throw new Error(
      "EKS auth requires @aws-sdk/client-eks. Install it to enable EKS token auth.",
    );
  }
};

const loadStsSdk = (): {
  STSClient: new (config: { region: string; credentials?: unknown }) => {
    config: { credentials: unknown };
  };
} => {
  try {
    return requireModule("@aws-sdk/client-sts");
  } catch {
    throw new Error(
      "EKS auth requires @aws-sdk/client-sts. Install it to enable EKS token auth.",
    );
  }
};

const loadSignatureV4 = (): { SignatureV4: new (input: { credentials: unknown; region: string; service: string; sha256: unknown }) => { presign: (req: unknown, opts: { expiresIn: number; signingDate?: Date }) => Promise<unknown> } } => {
  try {
    return requireModule("@smithy/signature-v4");
  } catch {
    throw new Error(
      "EKS auth requires @smithy/signature-v4. Install it to enable EKS token auth.",
    );
  }
};

const loadProtocolHttp = (): { HttpRequest: new (input: { protocol: string; method: string; hostname: string; path: string; query: Record<string, string>; headers: Record<string, string> }) => unknown } => {
  try {
    return requireModule("@smithy/protocol-http");
  } catch {
    throw new Error(
      "EKS auth requires @smithy/protocol-http. Install it to enable EKS token auth.",
    );
  }
};

type HashInstance = {
  update: (data: string | Uint8Array, encoding?: string) => void;
  digest: () => Promise<Uint8Array>;
};

type HashCtor = new (
  algorithmIdentifier: string,
  secret?: string | Uint8Array,
) => HashInstance;

const loadHash = (): { Hash: HashCtor } => {
  try {
    return requireModule("@smithy/hash-node");
  } catch {
    throw new Error(
      "EKS auth requires @smithy/hash-node. Install it to enable EKS token auth.",
    );
  }
};

const loadCredentialProviders = (): {
  fromIni: (input: { profile: string }) => unknown;
  fromTemporaryCredentials: (input: {
    params: { RoleArn: string; RoleSessionName: string };
    clientConfig?: { region: string };
    masterCredentials?: unknown;
  }) => unknown;
} => {
  try {
    return requireModule("@aws-sdk/credential-providers");
  } catch {
    throw new Error(
      "EKS auth requires @aws-sdk/credential-providers when using profile override.",
    );
  }
};

const resolveBaseCredentials = (profile?: string, credentials?: unknown): unknown => {
  if (credentials) {
    return credentials;
  }
  if (!profile) {
    return undefined;
  }
  return loadCredentialProviders().fromIni({ profile });
};

const resolveCredentials = (
  profile?: string,
  credentials?: unknown,
  roleArn?: string,
  region?: string,
): unknown => {
  const baseCredentials = resolveBaseCredentials(profile, credentials);
  if (!roleArn) {
    return baseCredentials;
  }
  const { fromTemporaryCredentials } = loadCredentialProviders();
  const options: {
    params: { RoleArn: string; RoleSessionName: string };
    clientConfig?: { region: string };
    masterCredentials?: unknown;
  } = {
    params: {
      RoleArn: roleArn,
      RoleSessionName: `guck-eks-${Date.now()}`,
    },
    clientConfig: region ? { region } : undefined,
  };
  if (baseCredentials) {
    options.masterCredentials = baseCredentials;
  }
  return fromTemporaryCredentials(options);
};

const toBase64Url = (value: string): string => {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

const formatUrl = (request: {
  protocol?: string;
  hostname?: string;
  path?: string;
  query?: Record<string, string | number | Array<string | number> | undefined>;
}): string => {
  const protocol = request.protocol ? (request.protocol.endsWith(":") ? request.protocol : `${request.protocol}:`) : "https:";
  const hostname = request.hostname ?? "";
  const path = request.path ?? "/";
  const params = new URLSearchParams();
  const query = request.query ?? {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        params.append(key, String(entry));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const queryString = params.toString();
  return `${protocol}//${hostname}${path}${queryString ? `?${queryString}` : ""}`;
};

export const fetchEksClusterInfo = async (
  options: Pick<EksAuthOptions, "clusterName" | "region" | "profile" | "roleArn" | "credentials">,
): Promise<EksClusterInfo> => {
  const { EKSClient, DescribeClusterCommand } = loadEksSdk();
  const resolvedCredentials = resolveCredentials(
    options.profile,
    options.credentials,
    options.roleArn,
    options.region,
  );
  const client = new EKSClient({ region: options.region, credentials: resolvedCredentials });
  const response = await client.send(new DescribeClusterCommand({ name: options.clusterName }));
  const cluster = response.cluster;
  if (!cluster?.endpoint) {
    throw new Error(`EKS cluster ${options.clusterName} has no endpoint.`);
  }
  return {
    endpoint: cluster.endpoint,
    certificateAuthorityData: cluster.certificateAuthority?.data,
  };
};

export const buildEksToken = async (options: EksAuthOptions): Promise<EksTokenResult> => {
  const { SignatureV4 } = loadSignatureV4();
  const { HttpRequest } = loadProtocolHttp();
  const { Hash } = loadHash();
  class Sha256 {
    private hash: HashInstance;
    constructor(secret?: string | Uint8Array) {
      this.hash = new Hash("sha256", secret);
    }
    update(data: string | Uint8Array): void {
      this.hash.update(data);
    }
    digest(): Promise<Uint8Array> {
      return this.hash.digest();
    }
  }

  const resolvedCredentials = resolveCredentials(
    options.profile,
    options.credentials,
    options.roleArn,
    options.region,
  );
  const { STSClient } = loadStsSdk();
  const stsClient = new STSClient({
    region: options.region,
    credentials: resolvedCredentials,
  });

  const signer = new SignatureV4({
    credentials: stsClient.config.credentials,
    region: options.region,
    service: "sts",
    sha256: Sha256,
  });

  const hostname = `sts.${options.region}.amazonaws.com`;
  const request = new HttpRequest({
    protocol: "https:",
    method: "GET",
    hostname,
    path: "/",
    query: {
      Action: "GetCallerIdentity",
      Version: "2011-06-15",
    },
    headers: {
      host: hostname,
      "x-k8s-aws-id": options.clusterName,
    },
  });

  const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_EKS_TOKEN_TTL_SECONDS;
  const now = options.now ?? new Date();
  const signed = (await signer.presign(request, {
    expiresIn: expiresInSeconds,
    signingDate: now,
  })) as {
    protocol?: string;
    hostname?: string;
    path?: string;
    query?: Record<string, string | number | Array<string | number>>;
  };

  const url = formatUrl(signed);
  return {
    token: `k8s-aws-v1.${toBase64Url(url)}`,
    expiresAtMs: now.getTime() + expiresInSeconds * 1000,
  };
};
