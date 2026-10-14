import { Controller, INestApplication, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

/*
  A real multipart request through Nest's FileInterceptor, as the image endpoints use it.
  A broken install of multer's own dependencies (type-is 1.x resolving Express 5's media-typer)
  makes multer treat every upload as not-multipart: no error, the file is simply missing, and
  every image upload is refused as "no file". This fails here, in seconds, instead of in e2e.
*/
@Controller('probe')
class UploadProbeController {
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  upload(@UploadedFile() file?: { originalname: string; size: number; mimetype: string }) {
    return file ? { name: file.originalname, size: file.size, type: file.mimetype } : null;
  }
}

describe('multipart upload through FileInterceptor', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/probe`;
  });

  afterAll(() => app.close());

  it('hands the uploaded file to the handler', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(5000, 1)], { type: 'image/png' }), 'poster.png');
    const res = await fetch(url, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'poster.png', size: 5000, type: 'image/png' });
  });

  it('refuses a file over the limit with 413', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024 + 1, 1)]), 'big.png');
    const res = await fetch(url, { method: 'POST', body: form });
    expect(res.status).toBe(413);
  });
});
