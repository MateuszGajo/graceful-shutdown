import { GracefulShutdown } from '../gracefull'
import http from 'http'
import { AddressInfo } from 'net'


interface ServerResponse {
  server:  http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
  url: string
}

const createServer = async (responseTime: number): Promise<ServerResponse> => {
  const server = http.createServer()
  server.on('request', async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      setTimeout(() => {
        res.writeHead(200);
        res.end(JSON.stringify("hello"))
      }, responseTime)

    }
  })
  await new Promise<void>(resolve => server.listen(0, resolve));

  const { port } = server.address() as AddressInfo;
  const url = `http://localhost:${port}`;

  return {
    server,
    url
  }
}

interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  payload?: object
  headers?: http.OutgoingHttpHeaders
  agent?: http.Agent
}

interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  data: any
}

const createHttpClient = (agentOptions: http.AgentOptions = {}) => {
  const agent = new http.Agent(agentOptions)

  return (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> => {
    const { method = 'GET', payload, headers = {} } = options
    const body = payload ? JSON.stringify(payload) : undefined
    const parsed = new URL(url)

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        agent,
        headers: {
          ...(body && {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }),
          ...headers
        }
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => resolve({
          status: res.statusCode!,
          headers: res.headers,
          data: data ? JSON.parse(data) : null
        }))
        res.on('error', reject)
      })

      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }
}


test('should close server', async () => {
  const {server} = await createServer(1000);
  const shutdown = GracefulShutdown(server, { timeout: 5000 })

  await shutdown()

  expect(server.listening).toBe(false)
})

test('should finish request before killing app', async () => {
  const {server, url} = await createServer(1000)
  const shutdown = GracefulShutdown(server, { timeout: 5000 })
  const httpClient = createHttpClient()

  const [data] = await Promise.all([
    httpClient(url),
    // make sure to initiate shutdown when request is being in flight
    new Promise<void>(resolve => setTimeout(() => { shutdown().then(resolve) }, 50))
  ])

  expect(data.data).toEqual("hello")
  expect(data.headers.connection).toEqual("close")
  expect(server.listening).toBe(false)
})


test('Should not accept connection after shutdown', async () => {
  const {server, url} = await createServer(1000)
  const httpClient = createHttpClient()
  const shutdown = GracefulShutdown(server, { timeout: 5000 })

  await shutdown();
  const res = await httpClient(url).catch(e => e)

  expect(res.code).toBe('ECONNREFUSED')
  expect(server.listening).toBe(false)
})




test('keep-alive connection is closed after request finishes during shutdown', async () => {
  const {server, url} = await createServer(150)
  let connectionCount = 0
  server.on('connection', () => connectionCount++)
  const httpClient = createHttpClient(new http.Agent({keepAlive: true}))
  const shutdown = GracefulShutdown(server, { timeout: 5000 })

  await httpClient(url)

  const [result] = await Promise.all([
    httpClient(url),
    new Promise<void>(resolve => setTimeout(() => shutdown().then(resolve), 20))
  ])
  // makes sure same connection its used
  expect(connectionCount).toBe(1)
  expect(result.headers.connection).toBe('close')
  expect(result.data).toEqual('hello')

  const err = await httpClient(url).catch(e => e)

  expect(server.listening).toBe(false)
  expect(err.code).toBe('ECONNREFUSED')
})


test('should force close connection when timeout exceeded', async () => {
  const {server, url} = await createServer(15000)
  const httpClient = createHttpClient(new http.Agent({keepAlive: true}))
  const shutdown = GracefulShutdown(server, { timeout: 1000 })

  const [requestResult] = await Promise.all([
    httpClient(url).catch(err => err),
    new Promise<void>(resolve => setTimeout(() => shutdown().then(resolve), 50))
  ])

  expect(requestResult.code).toBe("ECONNRESET")
  expect(server.listening).toBe(false)
})

